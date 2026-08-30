# Plan: four boundaries, so nothing mixes silently

## Spec authority

`docs/TRD.md` (architecture, tool contract, data model §3) and `docs/PRD.md`
(FRs, NFRs, SRs). Where this plan and those disagree, they win.

## Why

One root cause produced every failure in this repo on 2026-08-30: **something
ambient decided behaviour, nothing declared it, and nothing checked.** Five
incidents, then a four-agent audit finding four Criticals, all the same shape:

| Incident | Ambient thing that decided |
|---|---|
| Test got 404 not 401, then hung forever | active transport |
| Prompt named `end_call`, absent on Vapi | active transport |
| `no such column: p.caregiver_id` | database history |
| `datatype mismatch` on a TEXT id | database history |
| Staleness test fails per-developer | a private `.env` |

Patching each is what produced them. This plan builds the four boundaries that
make the whole class impossible.

## Global constraints

- **Always HTTP 200 on tool endpoints.** Errors are `{"ok": false, "error": …}`.
  A non-2xx makes the agent stall and the parent hears silence (NFR-6).
- **No file outside `src/adapters/transport/` may name a vendor.** No
  `VAPI_*` / `ELEVENLABS_*` env read, no `api.vapi.ai`, no vendor string
  outside an adapter or its own config. This is the test for Tasks 1–2.
- **Safety-relevant settings fail closed.** Absent or malformed ⇒ refuse to
  boot, never proceed quietly.
- `rules/priority.py` purity, verbatim `log_observation`, and idempotency on
  natural keys are untouched by this plan. Do not modify them.
- Every task ships tests. Full suite green before a task is complete.
- Do not place a real phone call. Do not enable the scheduler.
- Do not delete or rebuild any database in `agent/data/`.

## Task 1 — A transport declares what it needs; the boot guard asks

**Fixes:** Critical — the boot guard validates `VAPI_SECRET` while the shipped
default transport is ElevenLabs (`config/providers.yaml:34`). With
`ELEVENLABS_WEBHOOK_SECRET` unset the server boots clean, calls connect, and
**every tool call 401s — including `report_outcome` with `ESCALATED_SYMPTOM`**
(`elevenlabs.js:184-189`; line 477 installs an empty token, so it is
self-consistently broken). A patient reports chest pain, the agent speaks the
reassurance line, and the family is never told. SR-1…SR-4.

**Do:**
- Add to `TransportPort` a `requiredSecrets()` returning `[{name, why}]`.
  Vapi returns `VAPI_SECRET`; ElevenLabs returns `ELEVENLABS_WEBHOOK_SECRET`
  and `ELEVENLABS_POST_CALL_SECRET`.
- `assertSafeToServe` takes the resolved transport and iterates
  `requiredSecrets()` instead of hardcoding `VAPI_SECRET`. Keep the existing
  `API_KEY` and `DISABLE_GUARDRAILS` checks unchanged.
- Add `ALERT_OPERATOR_CONTACT` to the guard: `.env.example` already says unset
  means escalations are "logged loudly but NOBODY is notified", which is the
  same defect class as the checks already covered.

**Verify:** a test per transport asserting boot refuses when that transport's
secret is missing, and boots when present. A test that the *other* transport's
secret is not required.

## Task 2 — Every outbound call goes through TransportPort

**Fixes:** Critical — `dialPatient` (`server.js:476`) reads
`VAPI_ASSISTANT_ID` and hands it to `transport.createCall(...)`. That variable
IS set in local `.env`, so under ElevenLabs it does not throw: it passes a Vapi
assistant id to ElevenLabs as its `agent_id`. This is the scheduled dose call —
the core product — dormant only because `SCHEDULER_ENABLED` is false. The
identical bug was already fixed 130 lines above for `POST /api/call`; the
scheduler was missed.

Also Important — `GET /api/call/:callId` (`server.js:393-423`) hardcodes
`VAPI_PRIVATE_KEY` and fetches `api.vapi.ai` directly, so it 500s under
ElevenLabs.

**Do:**
- `dialPatient` uses `transport.getAssistantId()`.
- Add `getCallStatus(callId)` to `TransportPort`; implement per adapter;
  `GET /api/call/:callId` delegates. ElevenLabs may return
  `{ok:false, error:'unsupported'}` if it has no equivalent — say so in the
  adapter, do not fake it.
- Fix the stale comment at `server.js:172` claiming `transport.start()` sets up
  Vapi routes unconditionally.

**Verify:** a test that no file outside `src/adapters/transport/` references a
vendor name or vendor env var (grep-based, and it will be the guard that keeps
this true). Tests for both routes under both transports.

## Task 3 — Boot states what it resolved; insecure mode cannot reach a network

**Fixes:** Important — the boot log records `active_stt/llm/tts`, persistence
class and scheduler state, but never the **active transport**, the **DB path**,
or the **auth mode** (`server.js:544-564`). This is why `npm start` silently
booting ElevenLabs was invisible. Also Critical — `ALLOW_INSECURE_LOCAL`
returns at the first line of `assertSafeToServe` with no localhost/tunnel
distinction, and this project's workflow routinely exposes the server through a
public Cloudflare tunnel.

**Do:**
- Boot log gains `active_transport`, resolved absolute `db_path`, `auth_mode`
  (`enforced` | `INSECURE`), and the resolved webhook URL actually wired into
  the transport (`server.js:179`, not rebuilt from `PORT` at 555-561).
- When `ALLOW_INSECURE_LOCAL` is on, refuse to bind anything but loopback;
  if the bind host is not loopback, fail closed with a message naming the
  conflict. Log a loud `auth_disabled` line every boot it is on.

**Verify:** tests asserting the boot log carries all four fields; a test that
insecure mode + non-loopback bind refuses to start.

## Task 4 — One schema authority, one version marker, no guessing

**Fixes:** Critical — there is no `user_version`, no migrations table, and
**two independent migration lists for one database**: `sqlite.js`
`_ensureColumn` and `api/db.py` `_ADDED_COLUMNS`, holding different columns, in
different languages, neither aware of the other. The DB's shape depends on
which process opened it last.

Worse, `_ensureColumn` cannot distinguish an **added** column from a
**renamed** one. `medications` was renamed `times`→`slots`,
`food_rule`→`with_food`, and lost `active`. Adding `slots` beside a populated
`times` strands the real schedule data in a column nothing reads — **silent
data loss, no error**. The `patients` fix committed earlier today was safe only
because those 13 were genuine additions.

**Do:**
- Set `PRAGMA user_version` to a schema version, defined once in
  `api/schema.sql` as the single authority.
- On open, both Node and Python compare `user_version` and take one of three
  verdicts: **current** (proceed), **migratable** (apply the additive steps for
  that version range, log each), **incompatible** (refuse to open, naming the
  found vs required version and telling the operator to rebuild). A DB whose
  key types are INTEGER where the schema says TEXT is incompatible — ALTER
  cannot fix it.
- Version 0 (no marker, pre-reconciliation) is **incompatible**. Never
  auto-rebuild: refusing is recoverable, silently losing a patient's schedule
  is not.
- The additive column lists stop being two hand-maintained lists. Derive them
  from `api/schema.sql`, or keep one list in one place both runtimes read.
  Never add a column whose name does not appear in `api/schema.sql`.

**Verify:** a test per verdict, using temp databases built to each shape —
current, additive-behind, and INTEGER-key. Assert the incompatible case
refuses and never writes. Assert no rename is ever auto-added.

## Task 5 — A committed artifact carries no developer's environment

**Fixes:** Important — `config/assistant.json` is committed but generated from
whoever last ran the generator with *their* `.env`. `WEBHOOK_URL` changed from
`api.voxikin.com` to `voice.voxikin.com` locally and the staleness test began
failing; "just re-run the generator" overwrites a teammate's URL with yours.
The test does not ask "is this file current?" but "does it match MY `.env`?".

**Do:** the generator writes a placeholder (e.g. `${WEBHOOK_URL}`) for every
environment-derived field, substituted at deploy/patch time. The committed file
becomes environment-free and the staleness test becomes deterministic for
everyone. Apply the same to `agent/tools.json` if it has the same property.

**Verify:** a test that the committed artifact contains no hostname, and that
substitution produces the previous concrete output.

## Task 6 — A hung test cannot hang forever

**Fixes:** Important — `npm test` inherits Node's unconfigured default of no
per-test timeout, so a hung test hangs indefinitely with no output. (There is
no `--test-timeout=0` flag anywhere; the default is the cause.) One hung
WebSocket test cost a full suite run today.

**Do:** set an explicit `--test-timeout` in the `npm test` script.

**Verify:** the suite still passes; a deliberately hanging test fails on time
rather than hanging (may be asserted in a scratch file, not committed).

## Out of scope

`app/`, `handoff/`, prompt wording, the ElevenLabs/Vapi feature sets
themselves, and anything requiring a live phone call.
