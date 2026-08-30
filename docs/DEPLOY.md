# Deploying Voxikin

Three pieces, all on free tiers: the caregiver app on Vercel, the Care API and
the voice agent as containers, and the database on Turso.

```
Vercel (app/)  ──rewrites──►  voxikin-api    ──┐
  browser stays same-origin      FastAPI        │
  cookie stays SameSite=Lax                     ├──►  Turso (libSQL)
                                                │
ElevenLabs ──webhooks/WS──►   voxikin-agent   ──┘
                                Express, ONE instance
```

The two services are decoupled at runtime — the agent never calls the Care API.
**The database is the only thing joining them.** A dose moved on the caregiver's
calendar changes which call the dialler places, and nothing else carries that. If
they end up on different databases the product looks healthy and is silently wrong,
which is exactly the state this repo was in before the move (`api/voxikin.db` had
the caregivers, `agent/data/voiceagent.db` had the calls, and neither had both).

---

## Why not Render for the agent

Two independent reasons, both from [Render's own free-tier docs](https://render.com/docs/free):

1. **The 750 free instance-hours are pooled per workspace, not per service.** One
   always-on service burns 744 h/month. Two need 1488, and Render suspends *every*
   free web service in the workspace for the rest of the month when the pool runs out.
2. **Free services sleep after 15 minutes idle and take ~60 s to wake.** The agent's
   `/el/tools/:name` endpoints fire *mid phone call*. The request would not error —
   ElevenLabs allows a long tool timeout — the elderly patient would just sit in a
   minute of silence. `agent/docs/SETUP.md` states the rule: *"Scale-to-zero is
   disqualifying."*

Render free is fine for the **API** alone, if you accept a cold start on the
caregiver app. It is not viable for the agent, and it cannot host both.

Free tiers that do keep a process awake: **Northflank Sandbox** (2 services, no
sleeping, card for identity) and an **Oracle Cloud Always Free** ARM VM (more
capable, but you run the box). Fly.io and Heroku no longer have free tiers; Koyeb
scales to zero after an hour.

---

## 1. Database — Turso

```bash
brew install tursodatabase/tap/turso   # or: curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create voxikin

# Apply the schema ONCE, out of band. Neither service does this at boot against
# a remote database — 430 statements over the network per start, from two
# services that restart independently and would race each other.
turso db shell voxikin < api/schema.sql

turso db show voxikin --url          # -> TURSO_DATABASE_URL
turso db tokens create voxikin       # -> TURSO_AUTH_TOKEN
```

Both services need **both** variables. Free plan is 5 GB, 500M row reads and 10M
row writes a month — far beyond this workload.

**Status: done.** `voxikin-soumya0343.aws-ap-south-1.turso.io` is created and the
schema is loaded — 18 tables, 35 indexes, no seed rows. Verified against it:

| Check | Result |
|---|---|
| `PRAGMA foreign_keys = ON` on a fresh remote connection | honoured — returns 1 |
| FK constraints actually enforced | yes — an orphan `auth_sessions` row is rejected |
| `db.insert()` upsert on `caregivers` | sessions survive; the caregiver stays signed in |
| Raw `INSERT OR REPLACE` on `caregivers` | **still destroys sessions (2 → 0)** |
| Python API writes → Node agent reads | confirmed, same rows |
| Latency from a dev laptop | ~120 ms/read, ~210 ms write+read round trip |
| `db.init()` over the network | 1.6 s |

The fourth row matters: the `_CASCADE_PARENTS` upsert in `api/db.py` is
**load-bearing on Turso, not vestigial**. The cascade that silently signed
caregivers out fires there exactly as it did locally. Do not "simplify" that
function back to a plain `INSERT OR REPLACE`.

The last two rows are why `VOXIKIN_MIGRATE_ON_BOOT` defaults off against a remote
database: 1.6 s per boot, per service, for a schema that is already applied.

Sanity check before deploying anything:

```bash
turso db shell voxikin "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

### Importing existing data

The two local files have diverged and neither is a superset:

| | `api/voxikin.db` | `agent/data/voiceagent.db` |
|---|---|---|
| caregivers | 5 | 0 |
| patients | 3 | 6 |
| medications | 10 | 0 |
| auth_sessions | 23 | 0 |
| calls | 0 | 15 |

They are dev and demo rows, made while `DEV_OTP_BYPASS_*` accepted every
destination. **Starting empty is the recommended path** — there is no clean key
mapping between the two patient sets, and re-onboarding through the real signup
flow is the same walkthrough you need for the demo anyway. If you do want the
caregiver-side rows, dump that one file and load it, and accept that the agent's
15 call records are dropped:

```bash
sqlite3 api/voxikin.db .dump > /tmp/dump.sql   # then hand-strip CREATE statements
turso db shell voxikin < /tmp/dump.sql
```

---

## 2. Care API

Build **from the repo root**, not from `api/` — the app is imported as
`api.main:app` and `api/config.py` reads `env_file=".env"` relative to CWD:

- Dockerfile: `api/Dockerfile`
- Build context: `.`
- Port: from `$PORT`
- Health check: `GET /health` → `{"ok": true, ...}`

`/health` answers 200 whenever the process is up and does **not** check the
database. A non-null `config_error` in the body means the prescription-reading
pipeline failed to build; that is deliberately not fatal to boot.

### Environment

| Variable | Value | Note |
|---|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | from step 1 | |
| `OTP_PEPPER` | ≥16 random chars | **hard-fails boot** if missing or short |
| `APP_ORIGIN` | the app's origin | |
| `COOKIE_SECURE` | `true` | the session cookie is the login |
| `PUBLIC_BASE_URL` | this service's URL | |
| `AGENT_BASE_URL` | the agent's URL | the two call buttons |
| `AGENT_API_KEY` | = the agent's `API_KEY` | |
| `CORS_ORIGINS` | app origin | only if you split origins; see step 4 |
| `GOOGLE_API_KEY` etc. | | prescription reading |
| `SMTP_*` / `RESEND_*` | | OTP email delivery |

**Three demo switches that must not ship** — all three are set the wrong way in
the working tree right now:

| Variable | Working tree | Production |
|---|---|---|
| `DEV_OTP_BYPASS_NUMBERS` / `_EMAILS` | `*` — a master key for every account | empty |
| `BILLING_AUTOCONFIRM` | `true` | `false` |
| `COOKIE_SECURE` | `false` | `true` |

---

## 3. Voice agent

- Dockerfile: `agent/Dockerfile`
- Build context: `.` (the root — the image needs `api/schema.sql`)
- Port: from `$PORT`
- Health check: `GET /health` → `{"status": "ok"}` (note: a *different* shape
  from the API's `{"ok": true}`)
- **Exactly one instance. Never two.**

One instance is not a preference. The agent PATCHes the single shared ElevenLabs
agent on every boot, and its scheduler dials on a bare `setInterval` with no
distributed lock. Two replicas fight over the agent config and double-dial every
due dose — to real phones, belonging to elderly patients.

### Environment

`assertSafeToServe` (`agent/src/core/safety-guard.js`) refuses to boot without
all of these, and `agent/.env` currently has none of them:

| Variable | Note |
|---|---|
| `API_KEY` | guards the HTTP + WS API. Empty today, which means **auth is off** |
| `ELEVENLABS_WEBHOOK_SECRET` | ours — the `X-Voxikin-Token` header |
| `ELEVENLABS_POST_CALL_SECRET` | theirs — `wsec_…`, prints **once** |
| `ELEVENLABS_AGENT_ID` | without it the boot-time agent patch fails |
| `ALERT_OPERATOR_CONTACT` | escalation target |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | the same database as the API |
| `WEBHOOK_URL` | the final public HTTPS origin, **no trailing slash** |
| `SCHEDULER_ENABLED` | `true` on one instance only, and only when you want it dialling |

Generate the two ElevenLabs secrets with the scripts already in the repo:

```bash
cd agent
npm run setup-elevenlabs           # prints ELEVENLABS_AGENT_ID
npm run setup-elevenlabs-webhook   # prints the post-call secret ONCE
```

**Remove `ALLOW_INSECURE_LOCAL`.** It is the only reason the agent boots today,
and it also forces a `127.0.0.1` bind — on a real host that is a service nothing
can reach. Leave `HOST` unset so it binds all interfaces.

**`WEBHOOK_URL` is not chicken-and-egg here, because the hostnames already
exist.** `voice.voxikin.com` and `api.voxikin.com` currently resolve to a
Cloudflare tunnel pointing at a laptop. This migration is a **DNS repoint, not a
new setup**: stand the services up on the new host, attach those same two custom
domains, cut DNS over, stop the tunnel. `WEBHOOK_URL=https://voice.voxikin.com`
never changes, so the ElevenLabs agent never needs re-patching to a new origin
and there is no window where a stale URL is registered.

That also settles the cookie question — see step 4.

If you ever *do* move to a new origin: the agent rewrites every tool URL on the
live ElevenLabs agent to `${WEBHOOK_URL}/el/tools/${name}` at startup, so it must
be the final origin before the first successful boot. Editing those URLs in the
ElevenLabs dashboard is pointless — the next boot overwrites them.

### ElevenLabs resources (already provisioned)

| Thing | Value |
|---|---|
| Agent | `agent_7601m182ajm7eyqrpnfmee816d0g` — "Kinvox Dose Call (outbound)" |
| Post-call webhook | `a5bdc85bd56d421f8b1193fe62b71793` → `https://voice.voxikin.com/el/post-call` |

Both already existed or are now created; **do not run `npm run setup-elevenlabs`**,
which would duplicate the source agent a second time. The workspace also still
holds an older webhook `f20f7329…` pointing at a dead ngrok host
(`unprosaically-hyperfunctional-genie.ngrok-free.dev`, confirmed 404). Its HMAC
secret was shown once and lost, which is why it could not be repaired and a
replacement was registered instead. Delete the stale one when convenient.

`webhook_secret` is returned by the create call **and nowhere else** — it cannot
be read back. Losing it means registering another webhook.

These must be publicly reachable over HTTPS: `/el/tools/:name`,
`/el/conversation-init`, `/el/post-call`. The host must also allow WebSocket
upgrades, for `/playground` (the app's `/setup/meet` screen) and `/api/stt`.

---

## 4. Caregiver app (Vercel)

The app sends `credentials: 'include'` and the API authenticates by httpOnly
cookie, but the API's CORS middleware does **not** set `allow_credentials=True`.
In dev this is invisible because Vite proxies same-origin. Split across two
origins, **login silently stops working.**

**This is already done — verified against the live site.** `app.voxikin.com`
answers `/auth/me` and `/app/record` with real API JSON while `/health` falls
through to the SPA, so the rewrites are in place (configured in the Vercel
dashboard, not in `app/vercel.json`). `VITE_API_BASE` is empty, the browser never
makes a cross-origin call, and the cookie stays `SameSite=Lax`. **No Vercel change
is needed for this migration** — keeping the `api.voxikin.com` hostname means the
rewrite destination stays valid.

`allow_credentials=True` has been added to the API's CORS middleware anyway. It
changes nothing while the proxy is in front, and it is what stops login breaking
silently the day someone points `VITE_API_BASE` straight at the API. A live
preflight against `api.voxikin.com` confirmed the header was previously absent.

For reference, the equivalent rewrite config in the repo would be:

```json
{
  "rewrites": [
    { "source": "/auth/:path*",   "destination": "https://<api-host>/auth/:path*" },
    { "source": "/app/:path*",    "destination": "https://<api-host>/app/:path*" },
    { "source": "/extract",       "destination": "https://<api-host>/extract" },
    { "source": "/h/:path*",      "destination": "/index.html" },
    { "source": "/(.*)",          "destination": "/index.html" }
  ]
}
```

The SPA catch-all must stay **last**, or a cold open of `/h/<token>` — the handoff
link a stranger opens on their own phone — returns 404.

Set `VITE_AGENT_BASE` to the agent's origin. It defaults to
`http://localhost:3001`, so `/setup/meet` currently opens its playground
WebSocket against the visitor's own laptop.

**Alternative, if you prefer split origins:** you own `voxikin.com`, and
`app.voxikin.com` / `api.voxikin.com` share a registrable domain, so they are
*same-site* and `SameSite=Lax` still works. You would only need to add
`allow_credentials=True` and an exact origin list to the CORS middleware in
`api/main.py`.

---

## 5. Verify

```bash
curl https://<api>/health      # {"ok":true,...,"config_error":null}
curl https://<agent>/health    # {"status":"ok"}
```

Then, in order — each step catches a different failure:

1. **Shared database.** Add a medication through the API, confirm the agent reads
   the same row. This is the integration the two services have no other channel for.
2. **Auth from the Vercel origin**, with the bypass codes cleared: OTP → signup →
   `/auth/me` returns 200. This is the check that catches the cookie/CORS problem.
3. **Voice.** Trigger a demo call from the caregiver panel, answer it, let it hit
   `/el/tools/*`, confirm the post-call webhook writes a `calls` row.
4. **Restart the agent** and confirm it re-PATCHes ElevenLabs with the right
   `WEBHOOK_URL` and comes back healthy.

---

## Local development is unchanged

No Turso account, no containers, nothing to provision:

```bash
.venv/bin/uvicorn api.main:app --reload --port 8000    # from the repo root
cd agent && npm start
cd app && npm run dev
```

With `TURSO_DATABASE_URL` unset, the API uses the stdlib `sqlite3` module against
a local file and the agent opens the same file, exactly as before. Both still
apply `api/schema.sql` at startup in that mode. To run the pair in containers
locally: `docker compose up --build` from the repo root.
