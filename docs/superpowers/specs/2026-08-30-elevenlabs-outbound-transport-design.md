# ElevenLabs as a second outbound pipeline

**Status:** implemented (branch `feat/elevenlabs-transport`), one item outstanding — see *Implementation notes* at the end
**Date:** 2026-08-30
**Scope:** outbound dose calls only. Inbound deferred — see *Out of scope*.

## Purpose

Run the scheduled "time for your medicine" call through ElevenLabs Agents as an
alternative to Vapi, chosen by one line in `config/providers.yaml`, so the two can be
compared on speech quality, latency and cost.

**What the comparison actually measures.** The chosen approach lets ElevenLabs run its
own LLM, so this compares *whole stacks* — Vapi + Sarvam + our engine against
ElevenLabs end to end — not two voice pipelines against a shared brain. A difference in
call quality cannot be attributed to the voice layer alone. That is a legitimate
question and it is the one this design answers; it is not the same as isolating
transcription and speech. Recorded here because the distinction is easy to lose later.

## What already exists

Discovered live against the account, not assumed:

| Thing | Value |
|---|---|
| Agent | `Elderly Medicine Reminder Agent`, `agent_4901m0kzym5pfm7b7y9aprndv6qp` |
| LLM | `gemini-2.5-flash`, ElevenLabs-hosted |
| TTS | `eleven_v3_conversational`, voice `QTKSa2Iyv0yoxvXY2V8a` |
| ASR | `scribe_realtime`, quality `high` |
| Prompt | 6,640 characters, already written |
| Phone number | `+18145243223`, inbound **and** outbound, already assigned to the agent |
| Tools | `send_guardian_alert` (webhook), plus `end_call` / `language_detection` / `voicemail_detection` (system) |

Two problems with it as it stands:

1. `send_guardian_alert` points at `https://penholder-robin-earful.ngrok-free.dev/...`
   — a tunnel that no longer resolves. Tool calls have been failing silently.
2. `language` is `en`, while the product is `hi-IN`.

Nothing in `agent/` knows any of this exists. `ELEVENLABS_AGENT_ID` is an empty
placeholder in `.env.example` that nothing reads.

## Architecture

`ElevenLabsTransportAdapter` implements the existing `TransportPort` and is registered
in `TRANSPORT_ADAPTERS` beside `vapi` and `playground`. `active.transport: elevenlabs`
selects it. **The Vapi path is not modified.**

### Which agent we patch

**We do not mutate `agent_4901m0kzym5pfm7b7y9aprndv6qp`.** It is the prior product's
agent — `en`, its own 6,640-character prompt — and rewriting it to `hi-IN` with our
strategy prompt would destroy something that exists and works, for a comparison that
might not be kept.

Instead: `POST /v1/convai/agents/{id}/duplicate` once, as a one-off setup step, into a
Voxikin-managed agent. Its id goes in `ELEVENLABS_AGENT_ID` — the placeholder that has
been sitting empty in `.env.example`. Every subsequent PATCH targets only the copy, so
the original stays exactly as it is and can be diffed against ours.

| `TransportPort` method | ElevenLabs |
|---|---|
| `buildAssistantConfig(strategy, providers, webhookUrl)` | Builds the agent patch: prompt from the active strategy, `hi-IN`, our voice, and webhook tools whose URLs are derived from `webhookUrl`. |
| `start(server, engine, config)` | Mounts `POST /el/tools/:name` and `POST /el/post-call`. On boot, PATCHes the agent so its tool URLs match the current tunnel. |
| `createCall(assistantId, phoneNumber, variables)` | `POST /v1/convai/twilio/outbound-call`. |

Our `/llm/chat/completions` endpoint is **not used**. The engine is reached only through
tool calls. The consequence is that the turn policy and safety guardrails in
`agent/prompts/5-guardrails.md` have to be carried into the ElevenLabs agent prompt,
because nothing of ours sits between the model and the caller. That is the substance of
this work: it is more prompt carriage than plumbing.

The prompt is **generated from the same strategy files Vapi uses**, not hand-copied.
`buildAssistantConfig` composes it from the active strategy exactly as the Vapi adapter
composes its system prompt, so a guardrail edit lands on both transports or neither.
Hand-copying would guarantee drift, and `SETUP.md` already records this going wrong once
— a stale `config/assistant.json` carrying v1 guardrails while the repo ran v4.

## Tool contract

`tools.json` declares exactly two tools. Both are mirrored as ElevenLabs webhook tools
against `POST /el/tools/:name`; the handler translates the body and calls the same
engine dispatch `vapi.js` already uses. The engine is not duplicated.

| Tool | `async` in tools.json | EL `execution_mode` | Notes |
|---|---|---|---|
| `report_outcome` | `false` | `sync` | Exactly once per call. Enum of six outcomes plus a reason. Two of them (`ESCALATED_SYMPTOM`, `ESCALATED_DISTRESS`) alert the family, so the write must land before the agent proceeds. |
| `capture_field` | `true` | `async` | Per turn, verbatim. Not on the outbound dose path today — its fields are intake — but declared so the contract does not diverge between transports. |

Declaration shape is taken from the live `send_guardian_alert`: `api_schema` with
`request_body_schema`, typed properties, `response_timeout_secs`, `execution_mode`.

`send_guardian_alert` is **retired**, not repointed. Escalation is an outcome of
`report_outcome`, and two tools that both alert the family is one too many.

## Outbound dispatch

```
POST /v1/convai/twilio/outbound-call
  required: agent_id, agent_phone_number_id, to_number
  optional: conversation_initiation_client_data.dynamic_variables
```

Confirmed from the OpenAPI spec, not from prose docs. Per-call variables —
`patient_name`, `meal_slot`, medicine name — go in `dynamic_variables`, matching the
`{{patient_name}}` placeholders already in the agent's first message.

## Capturing the comparison

`POST /el/post-call` writes transcript, recording URL, duration and cost into the
**existing `calls` table**, with `outcome_source` naming the stack. Both pipelines then
land in one place and `scripts/ground-truth.js` scores them unchanged. No new reporting.

## Configuration

```yaml
# config/providers.yaml
active:
  transport: elevenlabs        # or vapi

transport:
  elevenlabs:
    agent_id_env: ELEVENLABS_AGENT_ID
    phone_number_id: phnum_2001m0m0dch2fvhv1jar36bfzd5p
    api_key_env: ELEVENLABS_API_KEY
```

`WEBHOOK_URL` must be a live public HTTPS origin. On the free ngrok tier it changes on
every restart, which is how the current agent came to point at a dead host — so the
adapter re-PATCHes tool URLs on boot rather than trusting whatever is stored.

## Testing

1. **Mocked unit tests**, in the existing style — no network, matching how `vapi.js` is
   covered. Adapter shape, tool translation, dispatch, outbound payload construction.
2. **`POST /v1/convai/agents/{id}/simulate-conversation`** — exercises the real agent
   and its real tool calls without ringing anyone or spending call minutes. This is the
   integration test.
3. **One real call**, by explicit request only, as the final check.

The 588-test baseline must stay green throughout; it is the safety net for touching a
live calling path.

## Out of scope

- **Inbound calls.** No conversation-initiation webhook, no caller resolution, no
  session resume. While `active.transport: elevenlabs`, inbound is unavailable — this
  must be loud in `providers.yaml` so nobody flips it expecting a whole product.
- **Custom LLM.** Considered and rejected in favour of ElevenLabs' own model; see
  *Purpose* for what that costs the comparison.
- **Failover between transports.** One is active at a time.

## Risks

| Risk | Mitigation |
|---|---|
| Guardrails carried into the EL prompt drift from `prompts/5-guardrails.md` | Generate the EL prompt from the same strategy files rather than hand-copying |
| The webhook request/response shape is undocumented in EL's prose docs | Discover it empirically via `simulate-conversation` before relying on it |
| A dead tunnel silently breaks tool calls, as it already has once | Re-PATCH on boot; log the URL being installed |
| `hi-IN` on `scribe_realtime` is unverified for this use | Establish it in simulation before any real call |


---

# Implementation notes, 30 Aug

Built across 9 tasks plus 4 fix rounds. 633 tests green. `active.transport: elevenlabs`
is the committed default, with a `TRANSPORT` env override.

## Four contracts in this design were wrong

Every one was written from their OpenAPI spec or inferred from a live agent, and every
one was still wrong until a real call or a real PATCH rejected it. Recorded because the
lesson generalises: **ElevenLabs' prose docs do not specify request shapes, and their
OpenAPI spec carries enums without descriptions.**

| What the design said | What is true | How it was found |
|---|---|---|
| `execution_mode: 'sync'` | `'immediate'` / `'post_tool_speech'` / `'async'` | 400 on the first live PATCH |
| Tool property mirrors the live schema's field set | A property may set only ONE of `description`, `dynamic_variable`, `is_system_provided`, `constant_value`, `is_omitted` | 400 on a later PATCH |
| Agent takes a `post_call_webhook_url` | No such field exists. A workspace webhook object is created separately and referenced by `post_call_webhook_id` | Searching the spec after the brief's own "verify, don't guess" step |
| Route emits `tool:<name>` | The engine listens on `EVENT_TYPES.TOOL_CALLED` = `'tool.called'` | A real call: tools fired, nothing persisted |

The tests passed throughout, because they asserted the shapes this document invented.
A test that pins your own guess is not verification.

## The prompt must be templated, not interpolated

`buildAssistantConfig` originally passed `strategy.getVariables()` — the use-case config's
demo defaults — into `buildSystemPrompt`. That froze one script at boot with
`parent_name: "रोहन"` and `drug_name: "Crocin"`, and the first real call greeted the
patient by the sample name and asked about the sample medicine. It read as a vague,
uncomprehending agent; it was an agent given the wrong facts.

It now substitutes `{{key}}` for each key, producing a template ElevenLabs fills per call
from `dynamic_variables`. **Keys used for control flow are excluded** — the three
defaulting to `""` would flip an empty-check branch, and `alert_delivered` with its two
`_line` companions would either select the wrong guardrail line or speak a literal
placeholder aloud. Callers must send `parent_name` and `drug_name`, not `patient_name`.

## Outstanding

**The post-call webhook is not registered.** Creating it requires `webhooks_manage`, a
workspace role permission — not an API-key scope, so widening a key cannot fix it. Until
it exists, tool calls reach the engine mid-call but call *endings* do not, and outcomes
are never persisted. `ELEVENLABS_POST_CALL_WEBHOOK_ID` is read on boot and the wiring is
written and tested.

**Inbound remains unbuilt.** The `+18145243223` number is still assigned to the prior
product's agent for inbound. Reassigning it to ours would break inbound rather than
improve it: our prompt is an outbound dose-reminder opener, and with no dynamic variables
on an inbound call the placeholders arrive empty or are spoken literally. Inbound needs
the conversation-initiation webhook first.

## The English prompt has drifted, and is not shippable

`config/use-cases/medication-adherence-en.yaml` is at version 6 while the Hindi
config is at version 12. Every prompt fix made on 30 August — the output
contract that stops the model narrating its reasoning aloud, atomic escalation,
the reminder that makes it a reminder call, asking why a dose was refused, the
"when in doubt record DENIED" tiebreak, the mandatory spoken closing, and the
rule against reading CONFIRMED out of "maybe" — landed only in the Hindi file.

It is unreachable rather than merely stale: `server.js` builds the strategy with
no language argument and the constructor defaults to `hi`, and the adapter sends
`language: 'hi'` unconditionally. Nothing in `src/` selects `en`. So English is
dead config today, which is the only reason the drift has cost nothing yet.

Worth recording how it stayed invisible. `tests/prompt-safety-guardrails.test.js`
is named "ported guardrails exist in both languages" and was green throughout.
It regex-matches guardrail *labels* in both files. A label is not a behaviour,
and six versions of divergence sat underneath a passing test — the same shape as
the four API contracts this document already records, where a test pinned a name
rather than a contract.

Porting is three jobs. Translating v7-v12 is not mechanical, because several
rules lean on Hindi exemplars that carry the meaning: "अब क्या फायदा" is what
distinguishes hopelessness from an ordinary refusal, and the forbidden timing
instructions are listed as the phrases themselves. Language then has to be
threaded through `server.js` to the strategy and into `buildAssistantConfig`.
Finally the 21 scenarios in `scripts/lib/el-scenarios.js` are Hindi throughout —
simulated callers and `mustSay` patterns alike — so an English battery has to be
written before any English claim can be verified.

---

# Where this ended up, 30 Aug

The transport shipped, and the work then ran well past its original scope. What
follows is the state of it, and the pattern worth carrying forward.

## Built beyond the original design

**Inbound.** `POST /el/conversation-init` answers ElevenLabs' conversation-
initiation webhook with the strategy's inbound prompt and that caller's own
context, resolved from `caller_id`. The design listed inbound as out of scope
because the outbound dose opener would have been read to an inbound caller with
empty placeholders; this is what removes that objection. The number is still
**not** reassigned — see the open issues.

**A demo call.** `POST /app/demo-call`, one per caregiver, runs the real agent
against a scripted patient through `simulate-conversation` and returns a
transcript. No phone rings and nothing is recorded, which is the property that
makes it safe to put in front of a caregiver.

**A real test call.** `POST /app/test-call`, also one per caregiver, actually
dials. Deliberately a separate route, quota and button from the demo: a
transcript and a ringing telephone must never be one flag apart.

**An outcome backstop.** The agent declares a `dose_outcome` field that
ElevenLabs extracts from the transcript after the call, and `deriveOutcome`
reads it as tier 2. This is what stops a call whose agent forgot to invoke
`report_outcome` being recorded as `NO_ANSWER`.

**A scenario battery.** `npm run simulate-elevenlabs -- --all --repeat 3` runs
24 simulated callers and reports pass rates and LLM latency percentiles. Single
runs cannot distinguish a regression from variance, and reading one as the
other cost real time twice.

## The prompt went from v6 to v17

Driven by seven real calls, each of which found something the tests could not.
The defects removed: the model narrating its reasoning aloud to a patient in
English; claiming to be contacting the family when no alert had been raised;
reading "maybe" and "I will take it" as a taken dose; filing a missed dose
without ever reminding anyone; ending a call with no goodbye; escalating
ordinary irritation into a family alert; and inventing a food instruction for a
medicine that had none.

Two corrections worth recording because they cut against instinct. Removing the
reminder to satisfy an automated "no medical advice" score took the call from
33/100 to 100/100 and left an agent that files a record and rings off — the
evaluator measured compliance, not whether the call was worth making. And
trimming the prompt for latency bought nothing measurable while dropping the
"when in doubt, record DENIED" tiebreak, which immediately reopened a false
family alert.

## Latency

`thinking_budget: 0` was the whole win: LLM p90 fell from 3255ms to 826ms, and
the reasoning that no longer happens cannot leak into speech. `turn_eagerness:
eager` and a 180s call cap followed. Swapping the model was screened and
rejected — the fastest candidate dropped the reminder flow entirely.

## The pattern

The fixes that held removed the *ability* to go wrong. No food vocabulary in the
prompt to copy. A hard duration cap instead of asking the model to notice it was
looping. A boot-time version guard instead of trusting a parity test. The fixes
that half-worked were the ones that asked the model more firmly.

And twice a **passing test was the problem**: the English parity test matched
guardrail labels while ten versions drifted underneath it, and the battery
skipped its own expect/forbid checks exactly when the agent filed no outcome.
Both are fixed. Assume there are more of that shape.

