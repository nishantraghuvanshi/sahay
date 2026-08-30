'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
// Two files, deliberately. agent/.env holds what only the agent needs
// (WEBHOOK_URL, ports); the repo-root .env holds credentials shared with the
// Python Care API, so a key is configured once rather than copied. agent/.env
// is loaded first and dotenv does not overwrite, so the local file wins.
dotenv.config();
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

// Core
const { loadProvidersConfig } = require('./core/config/loader');
const ConversationEngine = require('./core/engine/engine');
const PluginRegistry = require('./core/plugins/registry');
const { assertPersistenceSatisfied } = require('./core/persistence-guard');
const { createWebhookCapture } = require('./utils/webhook-capture');

// Adapters
const ProviderRegistry = require('./adapters/providers/registry');
const TransportRegistry = require('./adapters/transport/registry');
const { captureRawBody } = require('./adapters/transport/elevenlabs-signature');
const ConsoleRepository = require('./adapters/persistence/console');
const SqliteRepository = require('./adapters/persistence/sqlite');

// Playground
const { handlePlaygroundConnection } = require('./playground/ws-handler');

// Middleware
const { apiKeyAuth, authenticateWebSocket } = require('./core/middleware/auth');

// Use cases
const { getActiveUseCase } = require('./use-cases/registry');

// --- Bootstrap ---

// 1. Load config
const providersConfig = loadProvidersConfig();

// 2. Get active use case
const useCase = getActiveUseCase();

// 3. Instantiate strategy
const StrategyClass = useCase.strategy;
const strategy = new StrategyClass();

// 4. Set up repository (Phase 1: SQLite, fallback to console if no DB)
// KINVOX_DB is the shared database the Python Care API also reads; DB_PATH and
// DATABASE_URL predate it and still work. Any of the three selects SQLite —
// without this, setting only KINVOX_DB left the console repository active and the
// persistence guard rejected the boot while a real database sat configured.
// DB_PATH and DATABASE_URL come first deliberately: they are set per invocation
// (a test spawning a server with its own temp file), and must beat KINVOX_DB, which
// is the shared product database and typically comes from .env. The other order
// silently pointed an isolated test at the real database.
const useSqlite =
  process.env.DB_PATH || process.env.DATABASE_URL || process.env.KINVOX_DB;
const repository = useSqlite
  ? new SqliteRepository({ dbPath: useSqlite })
  : new ConsoleRepository();

// 4b. Refuse to run a use case whose behaviour would be silently wrong
//     without persistence (inbound context, resume-after-drop).
assertPersistenceSatisfied(useCase, repository);

// 5. Set up plugin registry (after the repository — plugins depend on it)
const plugins = new PluginRegistry();
for (const PluginClass of useCase.plugins) {
  plugins.register(new PluginClass({ repository }));
}

// 6. Create conversation engine
const engine = new ConversationEngine({
  strategy,
  plugins,
  repository,
});

// 7. Create provider registry
const providerRegistry = new ProviderRegistry();

// 8. Create transport adapter (selected by active.transport in providers.yaml)
const transportRegistry = new TransportRegistry(providerRegistry);
const transport = transportRegistry.getActiveTransport();

// 8b. The playground is TransportRegistry's second real implementation —
// always instantiated alongside whichever transport is active, never itself
// "active.transport" (see registry.js).
const playgroundTransport = transportRegistry.getTransport('playground');

// --- Server ---

const app = express();
// The `verify` hook keeps the untouched request bytes on req.rawBody.
// ElevenLabs' post-call webhook signs `${timestamp}.${raw body}`, and
// express.json otherwise discards the buffer the moment it parses it —
// re-serialising the parsed object would reorder keys and change the digest.
// It has to sit on the parser: a route-level middleware runs after the global
// parser has already drained the stream.
app.use(express.json({ limit: '10mb', verify: captureRawBody }));
app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));

// Serve static files (playground UI, call form, browser JS)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Capture raw webhook bodies before anything parses them, so one real call
// settles the payload shapes this service currently only assumes.
// Opt-in via CAPTURE_WEBHOOKS=<path>; a no-op when unset.
app.use('/webhook', createWebhookCapture(process.env.CAPTURE_WEBHOOKS));

const server = http.createServer(app);

// WebSocket servers — one for Vapi STT, one for playground.
//
// Both use noServer and share ONE upgrade listener below. They must not be
// constructed with { server, path }: the ws library attaches its own 'upgrade'
// listener per instance, every listener fires for every upgrade, and an
// instance whose path does not match calls abortHandshake(socket, 400) —
// destroying the socket instead of ignoring it. With two path-scoped servers
// on one http server, whichever was constructed first killed every connection
// intended for the other. That is silent: nothing reaches either handler, so
// nothing is logged, and the browser only sees "could not connect".
const sttWss = new WebSocketServer({ noServer: true });
const playgroundWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }

  const target =
    pathname === '/api/stt' ? sttWss : pathname === '/playground' ? playgroundWss : null;

  if (!target) {
    console.log(JSON.stringify({ event: 'ws_upgrade_rejected', pathname, timestamp: new Date().toISOString() }));
    socket.destroy();
    return;
  }

  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

// Start transport (sets up Vapi routes: /llm/chat/completions, /api/tts/:provider, /webhook)
transport.start(server, engine, {
  wss: sttWss,
  app,
  providersConfig,
  strategy,
  repository,
  webhookUrl: process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 3001}`,
}).catch((err) => {
  // A transport that cannot finish starting must not take the server with it.
  // The routes it registered synchronously are already live, and the other
  // transports are unaffected. Loud, because the thing this most often means is
  // a stale tunnel — and silence is exactly the failure re-patching exists to end.
  console.log(JSON.stringify({
    event: 'transport_start_failed',
    transport: providersConfig.active.transport,
    error: err.message,
    timestamp: new Date().toISOString(),
  }));
});

// Wires the patient-picker route and stashes the repository/strategy the
// playground's lifecycle calls need.
// Protect the playground's HTTP routes BEFORE they are registered.
//
// Express walks one ordered middleware stack, so `app.use('/api', apiKeyAuth)`
// further down does NOT cover routes registered above it. The playground's
// patient-picker endpoint returns real patient rows — phone numbers, names,
// caregiver contacts — and was answering before auth ran.
//
// Scoped to /api/playground deliberately: moving the general /api guard above
// this point would also cover /api/tts/:provider, which Vapi itself calls when
// TTS is bridged, and would break the phone path.
app.use('/api/playground', apiKeyAuth);

playgroundTransport.start(server, engine, { app, repository, strategy }).catch((err) => {
  // Same reasoning as the primary transport's start() above: a failed start
  // must not take the whole server down with it.
  console.log(JSON.stringify({
    event: 'transport_start_failed',
    transport: 'playground',
    error: err.message,
    timestamp: new Date().toISOString(),
  }));
});

// --- Playground WebSocket endpoint ---
playgroundWss.on('connection', (ws, req) => {
  if (!authenticateWebSocket(req)) {
    ws.close(4001, 'Unauthorized: invalid or missing API key');
    return;
  }
  handlePlaygroundConnection(ws, { providerRegistry, strategy, transport: playgroundTransport });
});

// --- Routes ---

// Apply API key auth to all /api routes
app.use('/api', apiKeyAuth);

// Health check (public — no auth)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    useCase: strategy.name,
    promptVersion: strategy.getPromptVersion(),
    providers: providerRegistry.getActiveProviderNames(),
    plugins: plugins.plugins.map((p) => p.name),
    persistence: repository.constructor.name,
    timestamp: new Date().toISOString(),
  });
});

// Playground page
app.get('/playground', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Call form page
app.get('/call', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'call-form.html'));
});

// --- Call API ---

// Initiate an outbound call
app.post('/api/call', async (req, res) => {
  const { phone, name, drug, language, caregiver } = req.body;

  // Validate
  if (!phone || !phone.startsWith('+')) {
    return res.status(400).json({ error: 'Phone number must be E.164 format (start with +)' });
  }
  if (!name) {
    return res.status(400).json({ error: 'Parent name is required' });
  }
  if (!drug) {
    return res.status(400).json({ error: 'Drug name is required' });
  }

  // Ask the ACTIVE transport for its own id. Reading VAPI_ASSISTANT_ID here
  // hardcoded this route to one orchestrator: with active.transport:
  // elevenlabs it either failed for a missing Vapi variable or handed a Vapi
  // assistant id to ElevenLabs as its agent_id.
  let assistantId;
  try {
    assistantId = transport.getAssistantId();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    const variables = {
      parent_name: name,
      drug_name: drug,
      // The prompt templates {{caregiver_name}} into the escalation
      // reassurance line. Omitted, it is either spoken as a literal
      // placeholder or fails the call outright, so it is sent explicitly as
      // well as defaulted on the agent (dynamic_variable_placeholders).
      caregiver_name: caregiver || undefined,
      language: language || 'hi',
    };
    if (!variables.caregiver_name) delete variables.caregiver_name;

    const call = await transport.createCall(assistantId, phone, variables);

    res.json({
      callId: call.id,
      status: call.status || 'queued',
      phone,
      variables,
    });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'call_api_error',
      error: err.message,
      phone,
    }));
    res.status(500).json({ error: err.message });
  }
});

// Get call status (polls Vapi API)
app.get('/api/call/:callId', async (req, res) => {
  const { callId } = req.params;
  const apiKey = process.env.VAPI_PRIVATE_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'VAPI_PRIVATE_KEY not set' });
  }

  try {
    const response = await fetch(`https://api.vapi.ai/call/${callId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const call = await response.json();
    res.json({
      callId: call.id,
      status: call.status,
      duration: call.durationSeconds,
      cost: call.cost,
      outcome: call.analysis?.structuredData?.outcome,
      transcript: call.transcript,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Call history API (reads from local DB) ---

// List recent calls
app.get('/api/calls', async (req, res) => {
  try {
    const filters = {
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      outcome: req.query.outcome,
      phone: req.query.phone,
    };
    const calls = await repository.list(filters);
    res.json({ calls, count: calls.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single call with conversation history
app.get('/api/calls/:callId', async (req, res) => {
  try {
    const call = await repository.getCall(req.params.callId);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    const messages = await repository.getMessages(req.params.callId);
    res.json({ call, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(JSON.stringify({
    event: 'server_listening',
    port: PORT,
    use_case: strategy.name,
    prompt_version: strategy.getPromptVersion(),
    active_stt: providersConfig.active.stt,
    active_llm: providersConfig.active.llm,
    active_tts: providersConfig.active.tts,
    persistence: repository.constructor.name,
    endpoints: {
      health: `http://localhost:${PORT}/health`,
      playground: `http://localhost:${PORT}/playground`,
      call_form: `http://localhost:${PORT}/call`,
      call_api: `http://localhost:${PORT}/api/call`,
      calls_history: `http://localhost:${PORT}/api/calls`,
    },
    timestamp: new Date().toISOString(),
  }));
});
