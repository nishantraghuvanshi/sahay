# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: the adult child of an ageing Indian parent, living in another city, often opening the app anxious and in a hurry. Two questions drive every visit: *did she take her medicines?* and *is anything wrong?* The parent is never a user of this app — their entire interface is answering or placing an ordinary phone call.

Secondary audience for the build window: hackathon judges evaluating a screen recording, often watched with sound off.

## Product Purpose

Voxikin is an AI voice line that calls an ageing parent in India on a schedule to confirm each medicine dose and capture, verbatim, anything they say about how they feel — and picks up when the parent calls in, already knowing everything the outbound calls learned. This app is the adult child's window into what happened; they pay the subscription.

## Positioning

Every product in the category is one-directional and starts cold; Voxikin's value is the loop between outbound and inbound calls — the inbound line already knows. (PRD §1, team-stated.)

## Operating Context

- Hive Hackathon by ApplyBee AI, Startup Park Bangalore; code freeze 18:00 IST Aug 30 2026. Judged primarily from a screen recording.
- App: Vite + React 19 + TypeScript, React Router 7, TanStack Query, Tailwind v4 (`@theme` tokens in `app/src/index.css`), shared primitives in `app/src/ui/index.tsx`. ~20 routes, all built: login, 4-step setup (parent → prescription → schedule → consent), home, calendar, alerts + detail, calls + detail, care record, observations, medicines editor, settings, handoff, 404.
- Mobile-first (390pt phone layout), desktop uses extra width for split panes/tables. Four bottom tabs on mobile: Home · Calendar · Alerts · Calls — never a fifth. Desktop sidebar adds Care record, What she said, Settings.

## Capabilities and Constraints

Non-negotiable product/safety rules (from docs/EMERGENT_UI_PROMPT.md — breaking any is a regression):

1. Status never colour alone; shape + text label always (achromatopsia-safe).
2. Exactly three status marks: filled = taken/done/confirmed; outlined = missed/needs action; muted = upcoming/pending/locked.
3. One accent colour; emphasis via weight, border, whitespace.
4. Verbatim parent quotes rendered exactly, in quotation marks, never paraphrased — the most important text on any screen they appear on.
5. Never invent a score, gauge, or index. Severity is red/watch/none, each traceable to a sentence.
6. Alerts render the literal rule string (e.g. `rule: chest complaint with age over 40`) with a P1 badge; "No interpretation, no diagnosis" stays on screen.
7. Gated buttons stay visibly disabled with the reason adjacent.
8. The app never dials; call buttons hand off to the OS dialler and show the number.
9. Loading = skeleton in final layout shape, never spinners; no layout shift.
10. No placeholder text anywhere.

Scope constraint for UI work: presentation only — do not touch `app/src/api/`, `app/src/lib/`, `app/src/setup/store.ts`, or route definitions. `npm run typecheck` must pass.

## Brand Commitments

- Name: **Voxikin** (settled 30 Aug 2026; never submit under Voxikin).
- Committed visual system (binding, extend-don't-replace): warm cream neutral ramp, single blue accent (#3674b5), status colours layered on shaped marks; IBM Plex Sans body, Newsreader serif for the one hero line per screen, IBM Plex Sans Devanagari via `:lang()` for Hindi/Marathi; two warm-tinted elevation steps; settling motion (≤200ms, never springy), `prefers-reduced-motion` wired.
- [Inferred — question tool errored during init] Direction for the current craft pass: refine the incumbent world, not replace it, per docs/EMERGENT_UI_PROMPT.md "extend, do not replace".

## Evidence on Hand

- docs/PRD.md (evidence-legended market data: 149M Indians 60+, ~50% non-adherence, team survey n=31), docs/TRD.md, docs/IDEA_SCOPE.md, docs/EMERGENT_UI_PROMPT.md (design contract), docs/WIREFRAMES.md, wireframe/voxikin-system.html + voxikin-palettes.html.
- No real testimonials, pricing proof, or live-user data — do not fabricate any.

## Product Principles

- Answer "is she OK today?" before anything else; each screen has exactly one thing that leads.
- A calm day looks calm; a bad day is loud and unmistakable — same screen, both densities.
- The parent's own words outrank every derived signal.
- Trust through restraint: no scores, no diagnosis, no invented urgency.
- Every state legible at video bitrate: no tiny text, no low-contrast grey on cream, no meaning in a 7px dot.

## Accessibility & Inclusion

Achromatopsia-safe status marks (shape + label, verified via DevTools vision-deficiency emulation); ≥44px touch targets; `prefers-reduced-motion` respected; Devanagari font support for Hindi/Marathi content.

## Demo Priority

[Inferred — question tool errored during init] Demo-weighted effort: whole flow gets the pass; Home and Alert detail get the deepest craft, since the recorded demo is judged on them.
