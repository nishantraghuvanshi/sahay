/**
 * The single integration switch (LANE-C-APP.md: "one line to swap at integration").
 *
 * Live is now the default, and mock is opt-in with `VITE_API_BASE=/mock`.
 *
 * It was the other way round while Lane B's read endpoints did not exist. They do,
 * and the default outlived the reason for it: `.env` is gitignored, so "just set
 * VITE_API_BASE" meant a fresh clone — and every deployment nobody had hand-
 * configured — silently served the fixture household to every caregiver who
 * signed in. A default that quietly shows the wrong family's medicines is worse
 * than one that fails loudly against a backend that is not running.
 *
 * Empty rather than an origin: vite.config.ts proxies /app and /auth to the API in
 * dev, so the browser stays same-origin and the session cookie stays SameSite=Lax.
 * A cross-site base would need SameSite=None + Secure, which localhost cannot have.
 *
 * No bearer token lives here. The agent-facing tool contract (TRD §5) is server-to-server;
 * the browser only ever calls caregiver-scoped read endpoints (NFR-7).
 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? ''

/**
 * Prescription extraction, switched separately from the Care API above.
 *
 * These are two different backends at two different stages. The read endpoints
 * (`/app/record`, `/app/doses`, …) are Lane B's and do not exist yet, so the app
 * serves them from the mock. Extraction is real today, in Python, at its own origin.
 *
 * They were briefly behind the single `API_BASE` switch, and pointing that at the
 * extraction service 404'd every screen in the app — `hooks.ts` reads one flag to
 * decide mock-or-live for everything. One switch cannot describe two backends with
 * different readiness. Unset means the analysing screen uses its fixture, exactly as
 * before, so the app still runs standalone with no Python process at all.
 */
export const EXTRACT_API_BASE = import.meta.env.VITE_EXTRACT_API_BASE ?? ''

/**
 * Auth and onboarding never mock. `API_BASE` can sit on `/mock` all it likes —
 * a login that pretends is exactly what this replaced — so these calls have
 * their own base, empty by default so they go same-origin through the dev proxy
 * in vite.config.ts and the session cookie stays SameSite=Lax.
 */
export const AUTH_BASE = import.meta.env.VITE_AUTH_BASE ?? ''

/**
 * VITE_DEV_MODE=true fakes a signed-in caregiver, seeds the onboarding draft with
 * dummy data and opens straight on /setup/prescription. Gated on the Vite dev
 * build so a stray env var can never switch it on in production.
 */
export const DEV_MODE = import.meta.env.DEV && import.meta.env.VITE_DEV_MODE === 'true'

/** Poll interval for screens that must visibly change while a call is happening. */
export const LIVE_POLL_MS = 5000

/** Breakpoint where the phone layout (tab bar) becomes the desktop layout (sidebar). */
// Must match Tailwind's `lg:` (1024px). At 900 the shell switched to the desktop
// sidebar while screens were still rendering their single-column mobile layout.
export const DESKTOP_MIN_PX = 1024

/**
 * Origin of the voice agent bridge server (`agent/`), which hosts the
 * `/playground` WebSocket the "meet the agent" step talks to.
 *
 * Not `API_BASE`: the Care API and the agent are two different servers on two
 * different ports, and the playground socket never goes through the Care API.
 * Empty means same-origin, which is what a reverse-proxied deployment wants;
 * the default is the port `agent/src/server.js` listens on locally.
 */
export const AGENT_BASE = import.meta.env.VITE_AGENT_BASE ?? 'http://localhost:3001'
