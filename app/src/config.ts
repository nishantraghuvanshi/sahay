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

/** Poll interval for screens that must visibly change while a call is happening. */
export const LIVE_POLL_MS = 5000

/** Breakpoint where the phone layout (tab bar) becomes the desktop layout (sidebar). */
export const DESKTOP_MIN_PX = 900
