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
const { assertSafeToServe, resolveBindHost, isInsecureLocalOn, OPT_OUT } = require('./core/safety-guard');
const { asyncRoute, errorMiddleware, installProcessHandlers } = require('./core/errors');
const { createScheduler } = require('./core/scheduler/loop');
const { createDoseTick } = require('./use-cases/medication-adherence/scheduling/tick');

const { createWebhookCapture } = require('./utils/webhook-capture');

// Adapters
const ProviderRegistry = require('./adapters/providers/registry');
const TransportRegistry = require('./adapters/transport/registry');
const { captureRawBody } = require('./adapters/transport/elevenlabs-signature');
const ConsoleRepository = require('./adapters/persistence/console');
const SqliteRepository = require('./adapters/persistence/sqlite');
const { redactCredentials, resolveConfiguredDbPath } = require('./utils/db-path');

// Playground
const { handlePlaygroundConnection } = require('./playground/ws-handler');

// Middleware
const { apiKeyAuth, authenticateWebSocket, hasValidApiKey } = require('./core/middleware/auth');

// Use cases
const { getActiveUseCase } = require('./use-cases/registry');
const {
  buildScheduleVariables,
} = require('./use-cases/medication-adherence/scheduling/call-variables');
const { runDemoCall, PERSONAS } = require('./use-cases/medication-adherence/demo-call');
const logger = require('./utils/logger');
const { utcToLocalParts } = require('./utils/time');

// Attach diagnostic context to fatal errors before any bootstrap work runs,
// so a failure during config load or DB open is reported with context.
installProcessHandlers();

// --- Bootstrap ---

// 1. Load config
const providersConfig = loadProvidersConfig();

// 2. Get active use case
const useCase = getActiveUseCase();

// 3. Instantiate strategy
const StrategyClass = useCase.strategy;
const strategy = new StrategyClass();

// 4. Set up repository (Phase 1: SQLite, fallback to console if no DB)
// VOXIKIN_DB is the shared database the Python Care API also reads; DB_PATH and
// DATABASE_URL predate it and still work. Any of the three selects SQLite —
// without this, setting only VOXIKIN_DB left the console repository active and the
// persistence guard rejected the boot while a real database sat configured.
// DB_PATH and DATABASE_URL come first deliberately: they are set per invocation
// (a test spawning a server with its own temp file), and must beat VOXIKIN_DB, which
// is the shared product database and typically comes from .env. The other order
// silently pointed an isolated test at the real database.
const { value: useSqlite, varName: dbPathVarName } = resolveConfiguredDbPath([
  'DB_PATH',
  'DATABASE_URL',
  'VOXIKIN_DB',
]);
const repository = useSqlite
  ? new SqliteRepository({ dbPath: useSqlite, dbPathSource: dbPathVarName })
  : new ConsoleRepository();

// db_path is meant to be a SQLite filesystem path, but DB_PATH, DATABASE_URL
// and VOXIKIN_DB have all been seen set to a Postgres connection string by
// mistake (see agent/postgresql:/... in this working tree) — and logging it
// verbatim would put the password in the log. SqliteRepository now refuses
// to open such a value outright (utils/db-path.js#assertFilesystemPath), so
// this redaction is defence-in-depth for a value about to be rejected
// anyway, not the primary defense. redactCredentials lives in
// utils/db-path.js so this boot log and SqliteRepository's own refusal
// message share one implementation.
//
// Resolved absolute path for the boot log — repository.dbPath may be
// relative (a test spawning a server with DB_PATH=./tmp/x.db), and null for
// ConsoleRepository, which has no file at all.
const dbPath = repository.dbPath ? path.resolve(redactCredentials(repository.dbPath)) : null;

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

// 8c. Refuse to serve traffic with authentication, the active transport's
//     own secret(s), operator alerting, or the prompt guardrails switched
//     off. All default to off when unconfigured and none is visible at
//     runtime, so the check belongs here rather than in a log line. Must
//     run after the transport is resolved (step 8) — it asks the transport
//     which secret(s) guard it rather than hardcoding one vendor. Nothing
//     between here and transport.start()/listen() below serves traffic, so
//     moving it this far down still fails closed before any request can
//     reach a route.
assertSafeToServe(process.env, transport);

// 8d. When ALLOW_INSECURE_LOCAL is on, the process must not become reachable
// from the network — this project routinely exposes the server through a
// public tunnel, and a process bound to all interfaces with API_KEY,
// transport secrets and operator alerting all off is one tunnel restart away
// from an open PHI endpoint. resolveBindHost() throws if HOST names anything
// but loopback while insecure; otherwise it defaults insecure mode to
// 127.0.0.1 and leaves HOST alone when insecure mode is off.
const BIND_HOST = resolveBindHost(process.env);
if (isInsecureLocalOn(process.env)) {
  // Loud on every boot, not once — this is exactly the state that must never
  // be missed by whoever is reading the log.
  console.log(JSON.stringify({
    event: 'auth_disabled',
    detail: `${OPT_OUT} is set — API_KEY, the active transport's own secret(s), guardrails ` +
      `and operator alerting are NOT enforced. Bound to ${BIND_HOST} only. Never set ` +
      `${OPT_OUT} in a deployment.`,
    timestamp: new Date().toISOString(),
  }));
}

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

// The webhook URL actually wired into the transport — computed once and
// reused verbatim in the boot log below, so the two can never disagree. A
// log rebuilt from PORT alone can print localhost while the transport is
// genuinely pointed at a public tunnel hostname, which is exactly the wrong
// answer during the debugging session where this line matters.
const webhookUrl = process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 3001}`;

// Start transport — the active transport wires whatever routes/sockets it
// needs. Vapi may add /llm/chat/completions, /api/tts/:provider, /webhook
// and the /api/stt socket (only the bridged ones); ElevenLabs and the
// playground wire their own, entirely different, routes.
transport.start(server, engine, {
  wss: sttWss,
  app,
  providersConfig,
  strategy,
  repository,
  webhookUrl,
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

// Health check (public — no auth). Must stay public and answer 200 when
// healthy: the Dockerfile and compose healthcheck both hit this with no
// credential. It used to hand every anonymous caller the use case, prompt
// version, active provider names, plugin list and persistence class — none
// of that is needed to know "is this alive", and all of it hands a would-be
// attacker a map of what to target. The liveness shape below never changes;
// the detail only appears for a caller who already holds API_KEY.
app.get('/health', (req, res) => {
  const body = {
    status: 'ok',
    timestamp: new Date().toISOString(),
  };

  if (hasValidApiKey(req)) {
    Object.assign(body, {
      useCase: strategy.name,
      promptVersion: strategy.getPromptVersion(),
      providers: providerRegistry.getActiveProviderNames(),
      plugins: plugins.plugins.map((p) => p.name),
      persistence: repository.constructor.name,
    });
  }

  res.json(body);
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

/**
 * Local "HH:MM" for the patient. Used to work out which dose slot an
 * unscheduled call is about — one placed by hand at 08:45 is about the 08:30
 * dose, not tonight's. India-only today, matching patients.timezone.
 */
function localHHMM(timeZone = 'Asia/Kolkata') {
  return utcToLocalParts(new Date().toISOString(), timeZone).hhmm;
}

// Initiate an outbound call
// A demo dose call: the real agent, the caregiver's real prescription, and
// nobody's phone rings. Returns the conversation as text.
//
// Separate from POST /api/call on purpose. That one dials a human being; this
// one cannot, and the two must not be a flag apart from each other — a demo
// that could ring a patient by accident is not a demo.
app.get('/api/demo-call/personas', (req, res) => {
  res.json({
    personas: Object.entries(PERSONAS).map(([key, p]) => ({ key, label: p.label })),
  });
});

app.post('/api/demo-call', async (req, res) => {
  const { phone, name, drug, caregiver, persona } = req.body || {};

  if (!name) return res.status(400).json({ error: 'Parent name is required' });
  if (!drug) return res.status(400).json({ error: 'Drug name is required' });

  try {
    const result = await runDemoCall({
      repository,
      phone,
      parentName: name,
      drugName: drug,
      caregiverName: caregiver,
      persona: persona || 'forgot',
    });
    logger.log('demo_call_completed', {
      persona: result.persona,
      turns: result.turns.length,
      outcome: result.outcome ? result.outcome.label : null,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    const known = { unknown_persona: 400, not_configured: 503, upstream_failed: 502 };
    const status = known[err.code] || 500;
    logger.log('demo_call_failed', { code: err.code || 'unknown', status });
    // err.message is safe here — this route is behind apiKeyAuth and the
    // messages are about our own configuration, not a caller's input.
    return res.status(status).json({ ok: false, error: err.code || 'demo_failed', detail: err.message });
  }
});

app.post('/api/call', asyncRoute(async (req, res) => {
  const { phone, name, drug, language, caregiver, slot } = req.body;

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
    // Pulled from the patient's own medication rows rather than from the
    // request: when the next dose is, and whether this one goes with food.
    // Both are precomputed here so the agent never has to work them out —
    // a model inventing a call time nobody will keep is the same defect as
    // claiming to have contacted the family. Empty means say nothing.
    const schedule = await buildScheduleVariables({
      repository,
      phone,
      slot,
      nowHHMM: localHHMM(),
    });

    const variables = {
      ...schedule,
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
}));

// Get call status — delegates to the active transport (see
// TransportPort#getCallStatus). Not every transport can answer this; one
// that can't returns { ok: false, error, httpStatus } instead of faking a
// status. This route is caregiver-app-facing, not a tool endpoint the voice
// agent calls mid-call, so it keeps its own non-200-on-error contract —
// NFR-6's always-200 rule is for tool endpoints and does not apply here.
app.get('/api/call/:callId', asyncRoute(async (req, res) => {
  const { callId } = req.params;

  let result;
  try {
    result = await transport.getCallStatus(callId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!result.ok) {
    return res.status(result.httpStatus || 500).json({ error: result.error });
  }

  const { ok, httpStatus, ...call } = result;
  res.json(call);
}));

// --- Call history API (reads from local DB) ---

// List recent calls
app.get('/api/calls', asyncRoute(async (req, res) => {
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
}));

// Get a single call with conversation history
app.get('/api/calls/:callId', asyncRoute(async (req, res) => {
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
}));

// Terminal error handler. Registered AFTER every route on purpose: Express
// walks one ordered stack, so a handler mounted earlier would catch nothing —
// the same ordering property that once served patient data before the auth
// middleware ran.
// --- Dose scheduler ---
//
// OFF unless SCHEDULER_ENABLED is explicitly true. This is a deliberate
// exception to the fail-closed default used everywhere else in this file: the
// dangerous state here is not "unconfigured", it is "dialling". An
// auto-starting dialler would place real phone calls to whatever numbers are
// seeded, from any machine that happens to run `npm start`, at whatever hour.
// Off-unless-asked is the safe default when the side effect leaves the process.
const SCHEDULER_ENABLED = String(process.env.SCHEDULER_ENABLED || '').toLowerCase() === 'true';
const SCHEDULER_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 60000);

/**
 * The one piece of transport the tick needs. Injected here so the use-case
 * layer keeps importing no vendor code.
 */
async function dialPatient({ doseEvent, medication, patient }) {
  // Ask the ACTIVE transport for its own id — see the identical comment on
  // POST /api/call above. This was the one caller still reading
  // VAPI_ASSISTANT_ID directly: harmless-looking under Vapi, but under
  // ElevenLabs it silently handed a Vapi assistant id to ElevenLabs as its
  // agent_id instead of throwing on a missing var.
  const assistantId = transport.getAssistantId();

  const call = await transport.createCall(assistantId, patient.phone_e164, {
    parent_name: patient.name,
    drug_name: medication && medication.name,
    language: patient.language || 'hi',
  });
  return { callId: call && call.id };
}

let scheduler = null;
if (SCHEDULER_ENABLED) {
  scheduler = createScheduler({
    tick: createDoseTick({ repository, dial: dialPatient }),
    intervalMs: SCHEDULER_INTERVAL_MS,
  });
  scheduler.start();
}
console.log(JSON.stringify({
  event: SCHEDULER_ENABLED ? 'scheduler_started' : 'scheduler_disabled',
  intervalMs: SCHEDULER_ENABLED ? SCHEDULER_INTERVAL_MS : null,
  detail: SCHEDULER_ENABLED
    ? 'Due doses will be dialled automatically.'
    : 'No dose will be dialled. Set SCHEDULER_ENABLED=true to enable outbound dialling.',
  timestamp: new Date().toISOString(),
}));

app.use(errorMiddleware);

// --- Graceful shutdown ---
//
// The Dockerfile runs this in a container, and `docker stop` sends SIGTERM
// then SIGKILLs 10 seconds later. Without a handler the scheduler's
// setInterval keeps the event loop alive, so the process never exits on its
// own and is killed mid-flight — potentially during an outbound dial, which
// on this system means a real phone call to an elderly patient.
//
// Stop the timer first so no NEW dial starts, then stop accepting
// connections. Anything already in flight finishes on its own; if it does
// not, the container runtime's own timeout is the backstop.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return; // a second SIGTERM must not re-enter this
  shuttingDown = true;

  console.log(JSON.stringify({
    event: 'shutdown_started',
    signal,
    schedulerRunning: Boolean(scheduler),
    timestamp: new Date().toISOString(),
  }));

  if (scheduler) scheduler.stop();
  server.close(() => {
    console.log(JSON.stringify({
      event: 'shutdown_complete',
      signal,
      timestamp: new Date().toISOString(),
    }));
    process.exit(0);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}

const PORT = process.env.PORT || 3001;

// BIND_HOST is only set when it must be — insecure mode (forced to
// loopback), or an operator explicitly configured HOST. Passing an explicit
// `undefined` host to listen() is not the same overload as omitting the
// argument entirely, so branch rather than rely on that being interchangeable.
const bootListening = () => {
  console.log(JSON.stringify({
    event: 'server_listening',
    port: PORT,
    host: BIND_HOST || '0.0.0.0',
    active_transport: transportRegistry.getActiveTransportName(),
    db_path: dbPath,
    auth_mode: isInsecureLocalOn(process.env) ? 'INSECURE' : 'enforced',
    webhook_url: webhookUrl,
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
};

if (BIND_HOST) {
  server.listen(PORT, BIND_HOST, bootListening);
} else {
  server.listen(PORT, bootListening);
}
