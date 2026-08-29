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

/** Poll interval for screens that must visibly change while a call is happening. */
export const LIVE_POLL_MS = 5000

/** Breakpoint where the phone layout (tab bar) becomes the desktop layout (sidebar). */
export const DESKTOP_MIN_PX = 900
