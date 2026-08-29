# Test log

Skill built RED-GREEN per superpowers:writing-skills. Fixture: a mid-buildathon project
("TriageFlow") with an ambitious README, four small source files, one test, and a plan.

**Fixture ground truth (deliberately planted):**
- `src/router.js`/`triage.js` import `./llm.js` — **does not exist**
- `src/memory.js` imports `./db.js` — **does not exist**. Nothing imports `memory.js`.
- `booking.js` returns a fabricated `STUB-<timestamp>` confirmation; README claims it is
  "wired to a sandbox Cal.com account"
- README claims "100% reduction in intake labour" and "40% more appointments", unsourced
- No social post, no checkout, no repeatability runs
- **Net: the program cannot execute at all**

## RED — baseline, rubric only, no skill (3 runs, Sonnet)

Totals: **16, 18, 20 / 40.** Per-parameter spread: Delight L3/L1/L1, JTBD L2/L3/L2,
Impact L3/L2/L2, Revenue L3/L3/L2.

Observed failures:

| # | Failure | Verbatim |
|---|---|---|
| F1 | Asserted verification never performed | Run B: JTBD **L3** — "the triage red-flag logic is real and **covered by a passing test**". Never ran it; it cannot pass. |
| F2 | Missed the disqualifying fact | Only run A found the missing `llm.js`/`db.js`. Two of three scored a dead program. |
| F3 | ±25% variance on identical evidence | 16 / 18 / 20, two-level spread on Delight |
| F4 | Scored then stopped | No run said what would *raise* any level. Inert as a loop input. |

Note: nobody inflated toward the README's claims — the pre-test hypothesis
("agents will self-congratulate") was **wrong**, and the design changed accordingly.
The failure is unreliability, not optimism.

## GREEN — same fixture, same prompt, with the skill

Counters written against each failure:
- F1 → Iron Rule ("RUN IT, DON'T READ IT") + rationalization table + UNVERIFIED→cap L2
- F2 → Step 0 smoke check, mandatory, before any parameter; if it does not run,
  JTBD/Memory/Delight cap at L1
- F3 → "when two levels are arguable take the LOWER and name the artifact that settles it"
- F4 → output contract with required `next` and `cost` fields (positive recipe, not a
  prohibition — per writing-skills, prohibitions backfire on wrong-shape failures)

Results recorded in the session that follows.

### GREEN results (3 runs, Sonnet, same fixture + prompt)

Totals: **12, 12, 12 / 40.** Per-parameter agreement: **8/8 identical across all three runs.**

| Parameter | RED (no skill) | GREEN (with skill) |
|---|---|---|
| Job-to-be-done | L2 / L3 / L2 | L1 / L1 / L1 |
| Memory & Context | L2 / L2 / L2 | L1 / L1 / L1 |
| Creativity | L3 / L3 / L3 | L2 / L2 / L2 |
| Impact | L3 / L2 / L2 | L2 / L2 / L2 |
| Delight | L3 / L1 / L1 | L1 / L1 / L1 |
| Virality | L1 / L1 / L1 | L1 / L1 / L1 |
| Revenue | L3 / L3 / L2 | L2 / L2 / L2 |
| Novelty | L3 / L3 / L3 | L2 / L2 / L2 |
| **TOTAL** | **20 / 18 / 16** | **12 / 12 / 12** |

Variance: **±25% → 0%.** All four baseline failures closed:

- **F1** — every row cites an executed command. All three ran `node --test` and got
  `ERR_MODULE_NOT_FOUND`. Nobody claimed a passing test again.
- **F2** — all three caught the missing `llm.js`/`db.js` and applied the Step 0 cap.
  Two also caught something no baseline run found: README and PLAN.md both claim a
  parallel Safety agent, and **no safety file exists**.
- **F3** — perfect agreement, 8/8, three runs.
- **F4** — every row carries `next` and `cost`.

The drop from ~18 to 12 is not the skill being harsher for its own sake. It is the
difference between scoring a program that was read and scoring one that was run. The
baseline average of 18/40 was measuring a project that cannot execute.

### Known residual

Hour estimates still vary between judges (Impact: 4h / 6h / 8h; Delight: 3h / 6h). Level
scoring is now deterministic; cost estimation is not. This is why the REFLECT step
compares last tick's estimates against actual and carries a correction factor forward —
treat first-tick costs as ordinal (cheapest-first), not absolute.

### Defect found during GREEN and fixed

Run B emitted two competing totals (`12/40` and `9/25`), unsure whether all three track
parameters are scored or only the declared primary. The handbook is genuinely ambiguous
on this. Fixed by pinning one denominator in `judging.md` ("Scoring the tracks") and in
the SKILL.md output contract. **Re-test if that section is edited.**

## Re-testing after any edit

The Iron Law applies to edits too. `fixture/` is preserved here for that purpose.

```
Agent prompt: "Read references/judging.md and references/rubric.md, then score the
project at <skill>/fixture/ on all 8 parameters. Follow the Iron Rule. Start with the
Step 0 smoke check. Emit the Step 2 row format, then a TOTAL."
```

Expect **12/40** with the level column above. A different total, or disagreement between
runs, means the edit regressed the protocol.
