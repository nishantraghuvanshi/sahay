# Evidence Map — the artifact that buys each level

The rubric scores demonstrated proof. This maps each parameter to the **specific file
that has to exist** for a level to be claimable, and where it lives.

Directory layout in the build repo:

```
evidence/
  jtbd/runs/run-01.json … run-NN.json   + SUMMARY.md   (pass rate across runs)
  memory/cross-session.log              transcript showing continuity
  delight/failure-path.md               the unhappy-path transcript
  impact/baseline.md                    the number, its source, the arithmetic
  revenue/checkout.png + orders.csv     checkout proof + any transaction
  virality/post-<platform>-<time>.png   timestamped analytics screenshots
  novelty/architecture.md               what is non-obvious and why
  creativity/framing.md                 the reframe, stated in one sentence
  demo/final.mp4 + fallback.mp4
```

**A parameter with an empty directory is L1.** No exceptions for work in progress.

---

## Job-to-be-done completion

| Level | Artifact that buys it |
|---|---|
| L1 | — (nothing runs, or the agent only talks about the job) |
| L2 | The flow runs but output is fake/broken. A stub returning a fabricated confirmation lands **exactly here** — the rubric's own example is telling a user money was reversed without checking the record. |
| L3 | One completed run against a mocked/sandbox surface that produced a **usable artifact you can open** — a real row in a sandbox CRM/Airtable/Notion, a real file. |
| L4 | A production-like run, most of the job, on a realistic workflow. Human approval at the end is allowed. |
| L5 | **`evidence/jtbd/runs/` with ≥3 runs and SUMMARY.md showing ≥85% success, zero builder intervention.** |

**The harness matters more than any single feature.** L5 asks for a success *rate*, and a
rate is not observable from one live demo — which is why most teams cap at L3–L4. Write
`scripts/repeat.sh` that runs the declared job N times and writes one JSON per run:

```
{"run":3,"case":"booking_hindi","started":"...","completed":true,
 "intervention":false,"artifact":"sandbox://appt/8831","failure":null}
```

`intervention: true` on any run means that run failed for L5 purposes, however it ended.

## Memory and Context

| Level | Artifact |
|---|---|
| L1 | — |
| L2 | It holds an identifier. A phone-number lookup that **nothing reads** is L2 at best; if no caller in the flow imports it, it is L1. |
| L3 | Transcript: an **authenticated** user, permissions honoured, an earlier answer reused instead of re-asked. |
| L4 | `cross-session.log`: session 1 ends, session 2 (or a different channel) resumes with no restart, auth intact. |
| L5 | The above **plus a business rule enforced from context** — a governing constraint the user never restated, applied correctly across a tool handoff. |

Cheapest real test: run the flow, kill the process, restart, continue. Log both halves.

## Creativity  ·  Novelty

Both are framing parameters and both are **time-locked** (see `clock.md`). The artifact
is a written claim you can defend in one sentence:

- `creativity/framing.md` — "Everyone builds X as \_\_\_. We build it as \_\_\_, which means the user never has to \_\_\_."
- `novelty/architecture.md` — what is non-obvious in the *architecture*, and what it buys the user.

L3 = one meaningful non-obvious choice. L4 = several reinforcing choices across framing,
interaction and workflow. L5 = a reframe that unlocks something previously impossible.
If your sentence still describes the obvious build, you are at L1–L2 and no amount of
implementation will move it.

## Impact

| Level | Artifact |
|---|---|
| L2 | A named user + a metric, frequency assumed. Movement <5%. |
| L3 | Who benefits, how often, defensible 5–<10% movement on one metric. |
| L4 | Defensible path to 10–30% on an operating/revenue/cost/risk/access metric. |
| L5 | Credible path to **>30%** or an equivalent step-change. |

`impact/baseline.md` must contain three things: **the baseline number, its source (a link
or a named person you asked), and the arithmetic** from baseline to claim.

Unsourced maximalism scores *lower* than a modest sourced claim. "100% reduction in intake
labour" reads as L2 (assumed) while "cuts 4h/day of intake to 40min, sourced from three
clinics we called, = 83% on one shift" reads as L5. The number is not the problem; the
missing source is.

## Delight

The scored moment is **friction, not the happy path.** A flawless success run is L2 —
"usable, but the care is generic."

`delight/failure-path.md` is a transcript of the product's **worst moment**: the caller is
frightened, the integration is down, the input is ambiguous, the answer is bad news.

- L3 — honest status, concrete next action, first-timer completes unaided
- L4 — truth without alarm, reassurance only where evidence supports it, recovers without losing progress
- L5 — anticipates the *next* concern before it is voiced, makes follow-up effortless

## Revenue

| Level | Artifact |
|---|---|
| L2 | A price with no unit economics behind it. |
| L3 | `checkout.png` — a **functioning** Stripe/UPI test checkout, or a pricing tier with defensible buyer ROI. |
| L4 | Willing-to-pay proof: simulated transactions, pre-order signups, or an explicit cost-reduction metric. |
| L5 | **Live revenue during the buildathon**, or validated LTV/CAC. |

T&C clause 09 permits database spot checks and contact checks with your signups. A signup
list you would not want a judge to phone is worth zero.

## Virality

Screenshots must show **the analytics panel, with a timestamp** — not the post. Capture at
several intervals (`post-linkedin-2340.png`, `post-linkedin-0900.png`) so growth is visible.
Thresholds: L3 = 500+ impressions · L4 = 2,000+ and multiple reshares · L5 = 10k+ and
reshares by industry leaders. Post early or concede the track — see `clock.md`.
