# Setup

Everything needed to get the voice agent from a fresh clone to a real phone call.
Written 2026-08-30. Every claim here was checked against the code, not the docs —
where something is unverified against a live call, it says so.

Work from the `agent/` directory throughout.

---

## 0. Prerequisites

- **Node 22 or newer.** `src/adapters/persistence/sqlite.js` uses `node:sqlite`, which
  needs 22+. (`package.json` still declares `>=18` — that floor is stale and is a
  deploy hazard, not a local one.)
- A phone you own, with the owner's consent. **Test on team members' phones only.**

```bash
cd agent
npm install
node -v          # must print v22 or higher
npm test         # baseline; everything should pass before you change anything
```

---

## 1. Environment file

```bash
cp .env.example .env
```

`.env.example` is annotated with where each key comes from and why. It is never
committed — the repo is public.

### Which keys, and why those

Which keys you need is decided by `config/providers.yaml` under `active:`. Today:

```yaml
active:
  transport: vapi
  stt: sarvam       # bridge  — audio flows through this server
  llm: openai       # bridge  — tokens flow through this server
  tts: elevenlabs   # native  — Vapi calls ElevenLabs directly
```

**bridge** means the key lives in `.env`, because this server makes the call.
**native** means Vapi makes the call, so the key lives in the Vapi dashboard.

| Variable | Where to get it | Notes |
|---|---|---|
| `SARVAM_API_KEY` | [dashboard.sarvam.ai](https://dashboard.sarvam.ai) → API Keys | Speech-to-text. Indic-specialised — that is why it is not a generic STT |
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | The active LLM. Needs billing enabled or every call 429s |
| `ELEVENLABS_API_KEY` | elevenlabs.io → profile → API Key | **Needed in BOTH `.env` and the Vapi dashboard.** See §3 |
| `VAPI_PRIVATE_KEY` | [dashboard.vapi.ai](https://dashboard.vapi.ai) → Settings → API Keys | Take the **private** key. The public key is for browser SDKs and fails here |
| `VAPI_ASSISTANT_ID` | Written by `npm run create-assistant` | Leave blank on first setup |
| `WEBHOOK_URL` | Your tunnel or deployment origin | Must be public HTTPS. See §4 |
| `DB_PATH` | `./data/voiceagent.db` | **Boot throws without it.** See §5 |
| `API_KEY` | Any shared secret you invent | Guards the patient endpoints. Unset = auth disabled |
| `ALERT_TELEGRAM_BOT_TOKEN` | Message `@BotFather` → `/newbot` | Where escalations go |
| `ALERT_OPERATOR_CONTACT` | Message `@userinfobot` for your chat id | Numeric |
| `TWILIO_*` | Twilio console | Only for the automated inbound wiring in §6 |

`GROQ_API_KEY` is only used if you switch `providers.yaml` to `llm: groq`. Leave it blank.

---

## 2. Why `DB_PATH` is not optional

The medication-adherence use case declares `requiresPersistence`, and
`src/core/persistence-guard.js` throws at boot without a database:

> Run against ConsoleRepository, such a use case does not fail — it succeeds
> incorrectly. The agent greets a known caller as a stranger, resume finds nothing to
> resume, and every log line looks healthy.

That is the whole reason the check exists at boot rather than as a warning. One
restart instead of one ruined demo.

---

## 3. ElevenLabs — the two-places problem, and the voice id

The key goes in **two** places, because ElevenLabs is used two different ways:

| Path | How it runs | Where the key goes |
|---|---|---|
| Phone | Vapi calls ElevenLabs directly (native) | **Vapi dashboard** → Provider Keys → ElevenLabs |
| `/playground` | Bridged through `src/adapters/providers/tts/elevenlabs.js` | **`.env`** as `ELEVENLABS_API_KEY` |

The playground adapter throws `Missing env var: ELEVENLABS_API_KEY` without it. Set
both, or the playground has no voice while the phone works, or vice versa.

### Check the voice id before you trust it

`config/providers.yaml` pins `voice_id: QTKSa2Iyv0yoxvXY2V8a`, commented as *"validated
on real elderly callers in a prior agent"*. That validation happened in a **different
ElevenLabs account**. Voice ids are not global — a cloned voice belongs to the account
that made it, and even a premade one has to be in your library before it resolves.

```bash
curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" \
  https://api.elevenlabs.io/v1/voices | grep -o "QTKSa2Iyv0yoxvXY2V8a"
```

No output means you must either add that voice in the ElevenLabs UI, or choose your own
and update `voice_id` in `providers.yaml`. **A missing voice id surfaces as silence, not
as an error.**

---

## 4. Public HTTPS for `WEBHOOK_URL`

Required even though every provider is bridged, because **Vapi calls you** — the webhook
is ours regardless of who runs the models.

```bash
ngrok http 3001
# or: cloudflared tunnel --url http://localhost:3001
```

Copy the `https://` origin into `WEBHOOK_URL`, **no trailing slash**. The server exposes
`{WEBHOOK_URL}/webhook`, and that exact URL goes into the Vapi number's Server URL field.

If you deploy instead of tunnelling:

- **Deploy near Vapi, not near your callers.** The hop you control is Vapi→you.
- **Scale-to-zero is disqualifying.** A cold start blows Vapi's 7.5-second
  assistant-request budget and the call dies before the greeting.

---

## 5. Generate and create the assistant

**Do not skip the regenerate step.** `config/assistant.json` in the repo is a stale
artifact carrying the **v1** prompt — no emotional-distress handling, no
delivery-conditioned alert wording, no third-party-answers branch, and forced
Devanagari-only output. Creating an assistant from it as-is installs those weaker
guardrails on the platform while the repo, tests and playground all run v4.

```bash
node scripts/generate-assistant-config.js    # rebuilds assistant.json from the strategy
npm run create-assistant                     # prints an assistant id
```

Put the printed id into `VAPI_ASSISTANT_ID`. If an assistant already exists, use
`npm run update-assistant` instead of creating a second one.

Re-run both **any time you change a prompt, a guardrail, or a call setting** — the call
budget, the voice, the tools. A prompt change that never reaches the platform is the
most expensive kind of silent no-op.

---

## 6. Point the phone number at Vapi

Two routes:

- **Vapi dashboard (simplest).** Import the Twilio number there. Needs no Twilio
  credentials in `.env`.
- **Automated.** Fill `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE`, then
  `npm run setup-inbound`.

Then, in the Vapi dashboard, confirm the number has **NO assistant assigned**, and its
Server URL is `{WEBHOOK_URL}/webhook`.

> An assistant attached to the number makes Vapi answer with a static greeting instead
> of asking this server who is calling. Inbound silently degrades — no patient lookup,
> no resume, no memory — and the logs stay healthy. Watch for `webhook_unknown_type`.

---

## 7. Seed a patient

Edit `SEED_PATIENTS` in `scripts/seed-medications.js`. It ships with the placeholder
`+919876543210`; replace it with a real, consenting team member's number.

```bash
node scripts/seed-medications.js            # idempotent; re-run after editing
node scripts/seed-medications.js --days=14  # longer dose_events look-ahead
```

Slot times are generated in the patient's local timezone, so `"08:00"` means 08:00 for
them. (Until 2026-08-30 this stamped local times as UTC, putting every seeded dose 5.5
hours out — re-seed any database created before then.)

---

## 8. Boot

```bash
DB_PATH=./data/voiceagent.db npm start
```

The boot log line should show `persistence: SqliteRepository`, the active providers, and
the prompt version. Anything else means a key or a path is wrong.

---

## 9. Test, in this order

Each step proves something the next one depends on. Do not skip to the phone.

### 9a. Playground — no phone, no Vapi

Open `http://localhost:3001/playground`. Pick a patient, choose inbound or outbound, and
talk. This exercises the **full** lifecycle — sessions, `capture_field`, resume — because
the playground is a real transport sharing the phone's code path. Session ids are
prefixed `playground-`, so simulated and real calls stay distinguishable in one database.

Proves: your Sarvam, OpenAI and ElevenLabs keys work, and the voice id resolves.

### 9b. Simulations — Vapi, still no phone

```bash
npm run simulate -- --scenario=confirm
```

Scenarios: `confirm`, `deny`, `clarify`, `symptom`, `negated-symptom`, `disclosure`,
`rambling`, `medical-advice`, `silence`, `voicemail`.

The safety-relevant ones are worth running every time a prompt changes:
`negated-symptom` ("कोई दर्द नहीं" must **not** escalate), `disclosure` ("are you a
machine?" must get an honest answer), `medical-advice` (must refuse).

### 9c. The real call — capture everything

```bash
CAPTURE_WEBHOOKS=./data/webhooks.jsonl DB_PATH=./data/voiceagent.db npm start
npm run make-call            # or ring the number yourself for inbound
```

**No real Vapi payload has ever been observed.** Every shape in this codebase comes from
documentation and fixtures. One captured call settles all of these at once:

| Unverified | What breaks if it is wrong |
|---|---|
| `tool-call` shape (`message.tool.{name,arguments}` vs `toolCallList[]`) | `capture_field` never fires — **resume is dead** |
| `endedReason` strings (code contains both hyphens and underscores) | Sessions close in the wrong state |
| `call.from.phoneNumber` | The caller never resolves; every inbound is a stranger |
| `artifactPlan.recordingEnabled`, `artifact.recordingUrl` | `recording_url` stays null |
| `'11labs'`, `eleven_turbo_v2_5` | Vapi rejects the voice config |
| ElevenLabs `output_format` param name | MP3 played as raw PCM — static, no error, no log |

Watch the logs: `assistant_request_answered` means inbound resolution worked.
`webhook_unknown_type` means §6 did not take.

---

## Troubleshooting, by symptom

| What you see | Almost certainly |
|---|---|
| Boot throws about persistence | `DB_PATH` unset |
| Boot throws `Missing env var: OPENAI_API_KEY` | `.env` copied from an older example that listed Groq instead |
| Playground is silent, no error | Voice id not in your ElevenLabs account (§3) |
| Playground plays static | ElevenLabs `output_format` mismatch — MP3 being played as PCM |
| Phone works, playground has no voice | `ELEVENLABS_API_KEY` missing from `.env` |
| Playground works, phone is silent | ElevenLabs key missing from the **Vapi dashboard**, or `'11labs'` is wrong |
| Inbound answers with a generic greeting | An assistant is still assigned to the number (§6) |
| `webhook_unknown_type` in the logs | Same as above |
| Call dies before the greeting | Cold start blew the 7.5s budget — no scale-to-zero (§4) |
| Agent uses old wording or old guardrails | Assistant not regenerated after a prompt change (§5) |
| Resume re-asks a question | `tool-call` payload shape mismatch — `capture_field` never fired |
| Escalation happens but nobody is told | `ALERT_*` unset. Check stderr for `escalation_not_delivered` |

---

## Safety rules that are not optional

- Test on team members' own phones, with consent. Never a real patient.
- No credentials in any commit. The repo is public.
- Never ship a recorded run containing a safety failure.
- The agent must never claim help was dispatched. No dispatch integration exists.
