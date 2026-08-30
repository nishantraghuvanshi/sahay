# UI improvement prompt — paste into Emergent

> **How to use.** Paste everything below the line as one message. Attach **screenshots of
> the screens you dislike** — without them the agent optimises blind and you get generic
> polish. If you can only attach a few, use Home, Alerts detail, and the Schedule step.
>
> **Before pasting, replace the two bracketed spots** — `[WHAT LOOKS WRONG]` and
> `[SCREENS]`. Everything else is ready.
>
> The same prompt works verbatim in Claude Code, Cursor or v0. It is written to be
> destructive-proof: it forbids rescaffolding, which is the main risk of handing a
> finished codebase to a generator.

---

## Task

Improve the **visual design and interaction quality** of an existing React app. Work
**in place, in the current codebase.** Do not rescaffold, do not migrate frameworks, do
not create a new project, do not rewrite routing or data fetching. This is a refinement
pass on presentation only.

## What the product is

**Kinvox** — an AI voice line that phones an ageing parent in India on a schedule to
confirm each medicine dose, and captures, verbatim, anything they say about how they
feel. The app is used by the **adult child**, usually in another city. The parent never
installs anything; their whole interface is answering a phone call.

The user opens this app anxious and in a hurry. Two questions matter: *did she take her
medicines?* and *is anything wrong?* Everything else is secondary.

## Current stack — keep all of it

- Vite + React 19 + TypeScript, React Router 7, TanStack Query
- **Tailwind CSS v4** with tokens declared in `@theme` in `src/index.css`
- Shared primitives in `src/ui/index.tsx`: `Card`, `Row`, `Chip`, `Tag`, `Dot`, `Button`,
  `Field`, `Label`, `Bar`
- ~20 routes, all built: login, 4-step setup (parent → prescription → schedule →
  consent), home, calendar, alerts + detail, calls + detail, care record, observations,
  medicines editor, settings, handoff, 404

## What is wrong right now

[WHAT LOOKS WRONG — describe in your own words. Examples of the kind of detail that
helps: "everything is the same size so nothing leads", "cards float in space with no
grouping", "the mobile layout is a desktop layout squeezed", "it reads like a form, not
a status board", "too much chrome around too little information".]

Focus on: [SCREENS — e.g. Home, Alerts detail, Schedule]

## The design system already exists. Extend it, do not replace it.

These tokens are in `src/index.css` under `@theme`. **Keep every one of these names.**
Add tokens if you need them; do not rename or delete.

```
Neutrals (warm cream ramp)
  --color-ink #1a1712        --color-ink-soft #3a342c
  --color-muted-strong #5e564a  --color-muted #8a8070
  --color-fill #e9dfcb       --color-fill-empty #cfc3a8
  --color-line #eadfc9       --color-line-strong #dcceb2
  --color-canvas #f9f0e0     --color-surface #fffcf6   --color-paper #ffffff

Accent — exactly one
  --color-accent #3674b5     --color-accent-2 #578fca  --color-accent-soft #e2ecf6

Status — layered onto a mark that already has shape and a text label
  --color-ok #3674b5   --color-warn #8a6100  --color-warn-soft #fdf0ce
  --color-danger #cc3a63  --color-danger-soft #fbe8ed  --color-highlight #fada7a

Type
  --font-sans     IBM Plex Sans
  --font-display  Newsreader (serif)
  --font-deva     IBM Plex Sans Devanagari   ← Hindi/Marathi, applied via :lang()
  Scale: 2xs 11 · xs 13 · sm 14 · base 15 · md 17 · lg 20 · xl 24 · 2xl 30 · 3xl 40 · 4xl 56

Elevation — two steps only, warm-tinted
  --shadow-card, --shadow-lift

Motion — settling, never springy
  --ease-out cubic-bezier(.22,.61,.36,1)   --ease-soft cubic-bezier(.4,0,.2,1)
```

## Non-negotiable rules

These come from the product spec and a medical-safety posture. Breaking any of them is a
regression, however good it looks.

1. **Status is never colour alone.** Every dose status, severity and step state carries a
   shape *and* a text label. Verify in DevTools → Rendering → Emulate vision deficiency →
   Achromatopsia: everything must still be distinguishable. Colour is layered on top of a
   mark that already works without it.
2. **Three status marks, no more:** filled = taken / done / confirmed / consent given ·
   outlined = missed / negative / needs action · muted = upcoming / pending / locked. The
   same three carry dose status, delivery state, step progress, radio and checkbox.
3. **One accent.** Emphasis comes from weight, border thickness and whitespace, not from
   new hues.
4. **Verbatim quotes are the product.** What the parent said is rendered exactly, in
   quotation marks, never summarised, never paraphrased. It should read as the most
   important text on any screen it appears on.
5. **Never invent a score.** No mood percentages, no sentiment bars, no wellbeing index,
   no "health score" ring. Severity is `red` / `watch` / `none`, and every one traces back
   to a sentence. If you feel the urge to add a gauge, add whitespace instead.
6. **Render the rule string literally.** Alerts show a `P1` badge above the exact text
   `rule: chest complaint with age over 40`. Never replace it with a category, an icon, or
   a diagnosis. The sentence "No interpretation, no diagnosis" stays on screen.
7. **Gated buttons stay visibly disabled with the reason next to them** — "2 left", "All
   three are mandatory". Do not hide gated actions; do not let a disabled button look
   clickable.
8. **The app never dials.** Call buttons open the phone dialler pre-filled and show the
   number or person they will dial. Style them as handoffs to the OS, not as in-app calls.
9. **Loading is a skeleton in the final layout's shape, never a spinner.** Nothing may
   shift when data lands.
10. **Four bottom tabs on mobile** — Home · Calendar · Alerts · Calls. Do not add a fifth.
    Desktop uses a left sidebar that adds Care record, What she said, Settings.
11. **No placeholder text of any kind** — no lorem ipsum, no `TODO`, no `copy TBC`.

## What "better" means here

Rank these in this order:

1. **Hierarchy.** Each screen has exactly one thing that leads — the next dose on Home,
   the critical alert when there is one. A stranger should know where to look in under a
   second. Most of the current flatness is probably here.
2. **Grouping and rhythm.** Related rows belong to one surface; unrelated ones are
   separated by real space, not by another border. Consistent vertical rhythm; consistent
   gaps between the same kinds of things. Fewer, larger surfaces beat many small boxes.
3. **Typography.** Real size contrast between a screen title, a section label and body
   text. Numbers and times use tabular figures (`.tnum` exists). Line length capped for
   readability. The serif display face earns its place on the one hero line per screen —
   it is not decoration to sprinkle.
4. **Density that matches the moment.** A calm day should look calm — mostly whitespace
   and one reassuring sentence. A bad day should be loud and unmistakable. The same
   screen must do both.
5. **Touch and motion.** Thumb-sized targets, ≥44px. Transitions ≤200ms with the existing
   easings, and nothing that bounces. Respect `prefers-reduced-motion` (already wired).
6. **Mobile first, genuinely.** Design the 390pt phone layout, then let desktop use its
   extra width for split panes and tables — not for stretched mobile components.

## Two screens carry the whole demo — spend the most effort here

- **Home** — must answer "is she OK today?" without scrolling. It carries the next dose,
  anything needing attention, the last thing she said verbatim, and a single merged
  chronological stream of everything since 6 AM (doses, calls, alerts).
- **Alert detail** — the `P1` badge, the literal rule string, the transcript excerpt with
  the triggering line highlighted, who has been told and who is still pending with a live
  countdown, then the call actions.

This app is judged from a **screen recording, often watched with the sound off**. Every
state must be legible at video bitrate: no 11px body text in production, no low-contrast
grey on cream, no information conveyed by a 7px dot alone.

## Deliverables

1. A short written diagnosis first — the top 5 problems, most damaging first, each with
   the specific screen and element. Do not start editing until you have written it.
2. Then the fixes, screen by screen, smallest diff that achieves the result.
3. Changes concentrated in `src/index.css` (`@theme` tokens) and `src/ui/index.tsx`
   (shared primitives) wherever a fix can be made once and inherited everywhere. Prefer
   fixing a primitive over patching ten call sites.
4. **Do not touch** `src/api/`, `src/lib/`, `src/setup/store.ts`, or route definitions in
   `App.tsx`. Presentation only.
5. Keep TypeScript compiling — `npm run typecheck` must pass when you are done.
6. Tell me what you changed and why, in a list I can scan. If you disagree with a
   constraint above, say so rather than quietly working around it.
