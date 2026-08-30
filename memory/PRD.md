# Voxikin — UI refinement pass

## Product
AI voice line that phones an ageing parent in India on a schedule to confirm each medicine
dose and capture, verbatim, how they feel. App is used by the adult child. Opened anxious,
in a hurry: "did she take her meds?" and "is anything wrong?".

## Stack (unchanged)
Vite + React 19 + TS, React Router 7, TanStack Query, Tailwind v4 (`@theme` in
`src/index.css`). App lives in `/app/app`. Mock API adapter (`src/api/mock.ts`) — no backend.
Run: `cd /app/app && yarn vite --host 0.0.0.0 --port 3000`.

## Scope of this pass (presentation only)
Visual design + interaction quality. Did NOT touch `src/api/`, `src/lib/`,
`src/setup/store.ts`, or route defs in `App.tsx`. Non-negotiable medical-safety rules kept
(status never colour-only; one accent; verbatim quotes; literal rule string; no invented
scores; gated buttons visibly disabled with reason; app never dials).

## Done (2026-06)
- `src/index.css`: implemented the full token system — warm cream neutral ramp, one accent
  (#3674b5), status colours (danger/warn/highlight), IBM Plex Sans + Newsreader (serif) +
  Plex Devanagari (auto via :lang), a semantic type scale (2xs–4xl), two warm shadows, easings,
  `.tnum`, entrance/shimmer animations respecting `prefers-reduced-motion`, accent selection.
- `src/ui/index.tsx`: upgraded every shared primitive (inherits app-wide). Card gains `danger`
  emphasis + elevation; Tag gains `tone` (ink/danger/warn/accent); DoseStatusChip/Dot/Severity
  layer colour onto shape+word; Buttons ≥44px pill + motion; larger legible type; skeleton bar.
- `src/shell/AppShell.tsx`: real lucide icons in tab bar + sidebar, accent active indicator,
  ≥56px tab targets, dropped the "scaffold" chrome.
- Hero screen `Home.tsx`: critical P1 alert now LEADS full-width (mobile + desktop), serif
  next-dose hero, colour-coded timeline, layout-shaped skeleton (no shift on load).
- Hero screen `AlertDetail.tsx`: P1 danger badge, danger-toned "why flagged" card, yellow
  `highlight` on the matched transcript line, colour-coded delivery dots, bigger hero quote.
- Config: `vite.config.ts` allowedHosts (preview), `tsconfig.json` + `@types/node` so
  `yarn typecheck` passes. lucide-react added.

## Backlog / not done
- Live countdown on Alert detail "pending" deliveries — no SLA/deadline field in the data, so
  not invented (would break the "never invent" rule). Needs a real deadline from the API.
- Per-screen skeletons in final-layout shape for screens other than Home (still use LoadingBlock).
- Calendar "priority" tag still ink (Home uses accent) — minor, intentional (metadata vs lead).
