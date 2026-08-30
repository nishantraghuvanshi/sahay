/**
 * The single integration switch (LANE-C-APP.md: "one line to swap at integration").
 *
 * Mock mode is the default so the app never blocks on Lane B. At integration set
 * VITE_API_BASE to the live Care API origin and change nothing else.
 *
 * No bearer token lives here. The agent-facing tool contract (TRD §5) is server-to-server;
 * the browser only ever calls caregiver-scoped read endpoints (NFR-7).
 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? '/mock'

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
