# Voxikin

**One AI voice line that calls an ageing parent on schedule to manage medicines, and
picks up when they call in — where the inbound call already knows everything the
outbound calls learned.**

Built at The Hive Hackathon by ApplyBee AI · Startup Park Bangalore · Aug 29–30 2026.
Primary track: **Revenue**.

---

## The problem

An adult child lives in another city. Their parent is 60+, takes 2–5 medicines a day,
and cannot use a smartphone — 9.7% of these parents are smartphone-confident and a
fifth are on feature phones. Nobody checks whether the tablet was actually taken;
roughly half of doses are missed, and forgetting is the top reason.

And when something does go wrong, the person who receives the parent — a neighbour, a
relative, a clinic desk — knows nothing. Not the medicines, not the allergies, not what
the parent said felt wrong yesterday. **The context exists. It is just never where it
is needed.**

## What it does

- **Calls out** on a schedule to confirm each dose and capture one wellbeing answer, verbatim
- **Picks up** when the parent calls in — already holding the full care record
- **Six of twelve** intake fields are inherited, not asked. A cold-start competitor asks all twelve
- **Resumes** a dropped call with nothing re-asked
- **Cites its rule** — priority is `P1 — rule: chest complaint with age over 40`, never `P1 — cardiac`
- **Hands off** to whoever is physically with the parent via a read-only link, no login

The parent installs nothing. Ever. Their entire interface is answering a phone call.

## Safety posture

Capture, never interpret. No diagnosis, no dosing guidance, no symptom interpretation,
and never a claim that help has been dispatched. Every transcript is automatically
scored against those rules; a violation is a failed run, not a warning.

## Repository layout and lane ownership

Each lane owns its directories exclusively. Git only fights you when two people edit the
same file — four people on one branch stays painless as long as nobody writes outside
their lane. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

| Path | Contents | Owner |
|---|---|---|
| `agent/` | Prompts, tool definitions, voice settings | **Lane A — Voice** |
| `api/` | 7 tools, priority rules, escalation, safety scorer, scheduler | **Lane B — Memory & API** |
| `api/auth/`, `api/caregiver/` | Caregiver OTP auth + the onboarding write | **Lane C** (built against Lane B's schema) |
| `scripts/mock_api.py`, `scripts/seed.py` | Mock contract server, seed loader | **Lane B** |
| `app/` | Caregiver app | **Lane C — App & handoff** |
| `handoff/` | Read-only `/h/{token}` view | **Lane C** |
| `evidence/` | Recordings, transcripts, scores, unit economics, payment proof | **Lane D — Evidence & revenue** |
| `scripts/cold-runs/` | The three cold-run scripts and the scoring sheet | **Lane D** |
| `README.md`, `docs/GTM.md` | Submission-facing writing | **Lane D** |
| `agent/tools.json` | **The frozen tool contract** — Lane B edits, only before the freeze | **Shared** |
| `docs/` | PRD, TRD, execution plan, build checklists | Anyone |
| `docs/DECISIONS.md` | Append-only decision log | Everyone writes |

## Build

Postgres 16+ is required — the schema uses `TEXT[]`, `JSONB` and partial indexes.

```bash
cp .env.example .env      # fill in — never commit this file

# database
createdb voxikin
psql -d postgres -c "CREATE ROLE voxikin LOGIN PASSWORD 'voxikin'"
psql "$DATABASE_URL" -f api/schema.sql      # idempotent, doubles as the migration

python3 -m venv .venv && .venv/bin/pip install -r api/requirements.txt
.venv/bin/uvicorn api.main:app --reload --port 8000
```

`OTP_PEPPER` is required and boot fails without it — a blank pepper would make every
stored OTP forgeable. Generate one:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

The Care API must be reachable over public HTTPS for the voice agent to call its tools.

### Caregiver auth

The caregiver app signs in by OTP — phone, then email — against our own API. Codes are
generated with `secrets.randbelow`, stored only as `HMAC-SHA256(code, OTP_PEPPER)`,
compared with `hmac.compare_digest`, and die on use, on expiry, or after five wrong
tries. The session is an opaque 256-bit token, held as `sha256` at rest and delivered in
an httpOnly cookie so no page script can read it.

This is separate from `CARE_API_TOKEN`, which is the agent↔API shared secret (`TRD §15`)
and never reaches a browser.

| Surface | Auth |
|---|---|
| The seven tools | `Authorization: Bearer {CARE_API_TOKEN}`, always HTTP 200 (`TRD §5.1`) |
| `/auth/*`, `/app/*` | Session cookie. A dead session is a real **401** — a browser route guard has to tell "signed out" from "broken" |
| `/h/{token}` | None. The token **is** the auth (`TRD §11`) |

**OTP delivery.** Email goes over SMTP if configured, else Resend. Phone walks the
`TRD §9` ladder — WhatsApp first, then SMS — because India's TRAI requires DLT
registration for A2P SMS, which takes days, and WhatsApp is not SMS. See
[`docs/WHATSAPP-OTP-SETUP.md`](docs/WHATSAPP-OTP-SETUP.md).

`DEV_OTP_BYPASS_NUMBERS` / `_EMAILS` give a listed destination a fixed code and skip the
carrier hop. Every other rule — hashing, expiry, attempt counting, session issue — runs
exactly as in production. Team destinations only, with consent (`SR-7`); leave empty in
any real deployment.

`DEV_OTP_BYPASS_NUMBERS=*` extends that to every phone number, which is what the demo
build runs while no WhatsApp sender is approved — without it, step 2 of signup cannot be
completed and there is no app to show. `DEV_OTP_BYPASS_EMAILS=*` does the same for every
email address, and is switched independently, since the two channels break for different
reasons. Either way nothing is sent: the code is always `DEV_OTP_BYPASS_CODE`.

Treat both as master keys: anyone who knows `DEV_OTP_BYPASS_CODE` can pass that channel
for any destination, including one that already has an account. The API logs a warning
per wildcard on every boot while they are set.

### Caregiver app

```bash
cd app
npm install
npm run dev                 # http://localhost:5173 — screens run on mock data; login needs the API
npm run build && npm run preview
```

The app ships as a static bundle. It talks to exactly one configurable origin:

```bash
# app/.env.local — unset means mock mode
VITE_API_BASE=https://your-care-api.example.com
```

Two things to know before deploying it:

- **Never put `CARE_API_TOKEN` in this file.** Anything prefixed `VITE_` is inlined into the
  browser bundle (`NFR-7`). The app reads caregiver-scoped endpoints only; the agent-facing tool
  contract stays server to server.
- **The host must fall back to `index.html` for unknown paths**, or a cold open of
  `/h/<token>` — the handoff link, opened by a stranger on their own phone — returns 404.
  `app/public/_redirects` covers Netlify and Cloudflare Pages; `app/vercel.json` covers Vercel.

## Documentation

| Doc | Question it answers |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | What and why |
| [`docs/TRD.md`](docs/TRD.md) | How |
| [`docs/IDEA_SCOPE.md`](docs/IDEA_SCOPE.md) | Who, when, what proof |
| [`docs/WIREFRAMES.md`](docs/WIREFRAMES.md) | What the app looks like and why — screen-by-screen spec |
| [`docs/WHATSAPP-OTP-SETUP.md`](docs/WHATSAPP-OTP-SETUP.md) | Getting real phone OTP delivery without waiting on DLT |
| [`docs/checklists/END-TO-END.md`](docs/checklists/END-TO-END.md) | The whole system, walked through |
| [`docs/checklists/MASTER-CHECKLIST.md`](docs/checklists/MASTER-CHECKLIST.md) | Every task, in clock order |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How we work together |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | What was decided, and why |

## Note on origin

Borderline starting point, flagged per the handbook: the author is a founder in
elder-care voice AI — pre-product, no codebase, never pitched or demoed. Prior work is
market research and a no-code voice agent, untouched here. This is a from-zero build
begun after kickoff. No prior code, agent config, product, or data was used or shown.
