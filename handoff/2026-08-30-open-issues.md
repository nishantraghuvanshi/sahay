# Handoff — Kinvox, 30 Aug

Paste this whole file as the first message of a new session.

---

## Where you are

Repo: `/Users/nishant/Desktop/projects/sahay`, branch `main`, pushed and in sync
with `origin/main` at `bf0dfea`.

Tests: **agent 762 · api 94 · app 16** (15 Calendar assertions parked on purpose,
see issue 5). All green.

Read these first, in order:

- `docs/superpowers/specs/2026-08-30-elevenlabs-outbound-transport-design.md` —
  the design, then the two sections appended at the end: the four API contracts
  it got wrong, and *"Where this ended up"*.
- `agent/docs/SETUP.md` — env vars, and which secret is ours vs ElevenLabs'.
- `agent/docs/demo-guide.md` — how to exercise it without ringing anyone.
- `docs/DECISIONS.md` — append-only. Add a row, never edit one.

## What works

The whole outbound path: a call is placed, the agent speaks Hindi with the
patient's real name, medicine, food rule and next-dose time, tool calls reach
the engine, the post-call webhook fires, the outcome is derived and persisted.
Seven real calls have run end to end.

Inbound is built but **not switched on** — see issue 1.

Two buttons at the bottom of the Calendar screen: a **demo call** (transcript
only, nothing recorded) and a **real test call** (actually dials). Separate
routes, separate quotas, one each per caregiver.

### Running it

```bash
ngrok http 3001                      # URL rotates on the free tier
# put the https origin in agent/.env as WEBHOOK_URL
cd agent && npm start                # re-patches the live agent on boot
cd agent && npm test                 # 762

# without ringing anyone:
npm run simulate-elevenlabs -- --all --repeat 3
npm run replay-post-call -- --conversation=conv_xxx --strip-tools
```

Env lives in two gitignored files: `agent/.env` and the repo-root `.env`. The
agent loads both.

### Two standing cautions

**The ElevenLabs API answers a wrong request shape with `200 OK` and silence.**
Five contracts have now been accepted and ignored rather than rejected. Probe
the live API and confirm the value came back on a GET. Never trust the schema
alone.

**`agent_4901m0kzym5pfm7b7y9aprndv6qp` must never be modified.** It is the prior
product's agent, kept for comparison. Ours is `ELEVENLABS_AGENT_ID`.

---

## Open issues, worst first

### 1. `/app/onboarding` is unauthenticated, and the authenticated one is dead code

**The real one.** There are two handlers. `api/routes_app.py` defines
`/app/onboarding`; `api/caregiver/routes.py` defines `/onboarding` behind an
`/app` prefix. `app_router` is included first in `api/main.py`, so the
`routes_app` one runs and the other never does.

The live one takes no `CaregiverDep`. It identifies the caregiver from a phone
number **in the request body**, so anyone can POST patient records for any
phone. The dead one is the correct, authenticated, session-scoped version.

Deciding which wins is not cosmetic: they take different payload shapes
(camelCase vs snake_case), and the app currently sends camelCase.
`api/tests/test_end_to_end.py` documents the behaviour as it is, not as it
should be — update it with the fix.

### 2. Inbound is built but the number is not switched to it

`POST /el/conversation-init` works: verified through the tunnel, greets a known
caller by name with the inbound prompt and no leftover placeholders, refuses
unauthenticated requests. `+18145243223` still routes to the **old** agent.

Before switching it, settle this: the webhook URL is the ngrok tunnel, which
rotates. Outbound survives that because the agent re-patches on boot; **inbound
does not** — a call arriving while the stored URL is stale gets no config and
the caller hears nothing. Either get a stable public URL, or accept that inbound
only works while the current tunnel is up.

### 3. Two scenarios still repeat themselves

`prompt_injection` and `medical_advice` decline correctly and then repeat the
same refusal until the turn cap. Both persist the right outcome every time, and
the 180s call cap bounds them on a real line, so this is a UX problem rather than
a data one.

Prompt rules have half-worked here repeatedly. The model cannot count its own
turns, so the next attempt should be structural, not another instruction.

### 4. `defers` and `hostile` occasionally disagree with themselves

Run `npm run simulate-elevenlabs -- --all --repeat 3` and read the rate column,
never a single run. Most scenarios are 3/3. These two vary between `DENIED` and
`UNCLEAR` — both defensible, which is why they are last on this list.

### 5. Thirteen Calendar assertions cannot be reinstated

The `origin/main` merge removed the features they pin: view modes, print and
share, the caregiver's dialable number, P2 alert display, the "happening now"
marker. Reinstating them means deciding to restore the features — a product
call. The file says which and why.

Two of the fifteen did survive and are already ported to
`app/src/ui/doseStatus.test.tsx`.

This pairs with the review you said you wanted: view/range chips vs week-nav
chips on Calendar, and "step 3 / 4" vs "2 / 4" on Analysing.

### 6. The English prompt is ten versions behind

`config/use-cases/medication-adherence-en.yaml` is v6; Hindi is v17. The
strategy now **refuses to load it** and names both versions, so it cannot reach
a caller. Porting is a real day's work — several rules lean on Hindi exemplars,
and `"अब क्या फायदा"` is what separates hopelessness from an ordinary refusal —
and the 24-scenario battery is Hindi throughout. Not worth doing until English
is actually on the roadmap.

### 7. Deploy prerequisites for the two call buttons

`AGENT_BASE_URL` (defaults to `http://localhost:3001`) and `AGENT_API_KEY` if
the agent has `API_KEY` set. Without them the panel reports the agent
unreachable — and correctly does not spend anyone's quota.

---

## Two lessons worth keeping

**Fixes that removed the ability to go wrong held. Fixes that asked the model
more firmly half-worked.** No food vocabulary in the prompt to copy. A hard
duration cap instead of asking it to notice a loop. A boot-time version guard
instead of a parity test. The prompt rules that stuck were the ones that took
something away.

**Twice a passing test was the problem.** The English parity test matched
guardrail *labels* while ten versions drifted underneath it. The battery skipped
its own expect/forbid checks exactly when the agent filed no outcome. Both are
fixed; assume there are more of that shape. When a test passes over a feature
that has just changed hands, check what it actually asserts.
