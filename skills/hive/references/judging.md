# The Judging Protocol

This file exists because of a measured failure. Three agents scored the same project
against the same rubric and returned **16, 18, and 20 out of 40** — a 25% spread, with
Delight ranging L1–L3 on identical evidence. One judge scored Job-to-be-done at L3
citing "covered by a passing test" without running the test; the test could not pass,
because the module under test imported a file that did not exist. Two of three judges
scored a program that **could not execute at all**.

A scoring signal with that much noise cannot drive an improvement loop. Everything
below exists to collapse the variance.

---

## The Iron Rule

> **RUN IT, DON'T READ IT.**

A level is earned by an **execution result**, never by reading code, a README, a plan,
or a comment. Reading produces inference, and inference is where the variance came from.

Every level claim must cite one of:

| Citation type | Form | Example |
|---|---|---|
| **Command** | the command + its actual output | `npm test` → `12 pass, 0 fail` |
| **Artifact** | a path that exists, with the fact it shows | `evidence/jtbd/run-03.json` → `"status":"booked"` |
| **Absence** | a check that came back empty | `grep -rl "recall(" src/` → no matches |

No citation? The parameter is **UNVERIFIED**, and an UNVERIFIED parameter is **capped at
L2** no matter how good the code looks. Write the gap down and move on. Do not argue the
cap; go and run the thing.

### Rationalizations that mean you are about to violate the Iron Rule

| Rationalization | Reality |
|---|---|
| "The test file clearly asserts the right thing" | An assertion is not a result. Run it. A test that cannot import its module asserts nothing. |
| "The code obviously works, it's four lines" | Four lines that import a missing module still crash. Run it. |
| "The README says it's wired to a sandbox account" | The README is the pitch. Handbook: judges score "the demonstrated product, not the pitch." |
| "PLAN.md has it checked off" | A checkbox is a claim by the person being scored. |
| "It's a stub but the real call is trivial to swap in" | Then swap it in and re-run. Until then the job is not completed. |
| "I can see the logic is correct" | You are inferring. Inference is the thing that produced a two-level spread. |
| "Running it takes too long" | Then the judges cannot run it either, and it does not demo. That is itself the finding. |
| "It ran earlier in the session" | Cite that run's output. If you cannot, run it again. |

---

## Step 0 — Smoke check, before any parameter is scored

Two of three baseline judges skipped this and scored a dead program.

1. Install/boot the thing the way a stranger would.
2. Run the declared happy path end to end, once.
3. Resolve every import/dependency in the entry path — does each target actually exist?

**If it does not run:** Job-to-be-done, Memory & Context, and Delight are capped at **L1**.
Not L2. A product that cannot execute has completed zero tasks, retained zero context, and
delighted no one. Record the failing command and its error as the first gap. Stop scoring
and go fix it — every other number is noise until this passes.

---

## Step 1 — Score each parameter

For each of the 8 parameters:

1. Open `references/rubric.md` and read the **full text** of the candidate levels. Quote
   the level language you are matching. The headline label is not the level.
2. Gather citations per the Iron Rule.
3. **When two levels are arguable, take the LOWER one** — and name the single artifact
   that would settle it. This is not pessimism; it is what converts a disagreement into a
   work item. "Arguable between L3 and L4" is not a score. "L3, and `evidence/memory/
   cross-session.log` would make it L4" is.
4. Write the strongest objection a hostile judge would raise. L4 requires the parameter
   "survives realistic challenge" — if you have not stated the challenge, you have not
   tested L4.

## Step 2 — Emit the row

Every parameter emits exactly this, in this order:

```
<PARAM>  L<n>  (<VERIFIED|UNVERIFIED>)
  evidence:  <command run → output, or path → fact>
  objection: <the strongest challenge a judge would raise>
  next:      <the ONE artifact that raises this to L<n+1>>
  cost:      <hours, estimated>
```

The `next` and `cost` fields are not optional and not commentary. They are what makes
the score actionable; a scorecard without them is an opinion. Baseline judges produced
none of them, which is why their output could not drive a loop.

---

## Independence

Score in a **subagent** whose entire context is: this file, `references/rubric.md`, and
the project directory. Do not pass it the plan, the scorecard, the previous tick's
results, or your hopes. The judge cannot rationalize what it has not been told, and a
clean context is what makes two consecutive ticks comparable.

Dispatch prompt:

> You are scoring a project at The Hive buildathon. Read `references/judging.md` and
> `references/rubric.md`, then score the project at `<path>` on all 8 parameters.
> Follow the Iron Rule: run commands, cite outputs, never infer from reading. Start with
> the Step 0 smoke check. Emit the Step 2 row format for every parameter, then a TOTAL.

## Calibration against the last tick

After the judge returns, compare to `.hive/scorecard.md`:

- **A level went UP** — confirm the citation is a *new* artifact, not a re-reading of old
  code. A level that rises with no new artifact is drift; revert it.
- **A level went DOWN** — this is legitimate and useful. Usually it means the previous
  tick's claim was UNVERIFIED and this tick actually ran it.
- **Nothing moved** — do not re-score next tick. Change what you are building.

---

## Scoring the tracks — resolve this before emitting a TOTAL

The handbook says both "every project is evaluated against our 3 official hackathon
tracks" **and** "pick your main track driver … judges evaluate how convincingly your
product demonstrates proof under your chosen track pillar." That is genuinely ambiguous
in the source, and an ambiguous denominator makes two ticks incomparable.

**Resolve it the same way every time:**

- Score **all 8** parameters. Always. `TOTAL: n/40`.
- Additionally report the primary track on its own: `primary track <T> at L<n>`.
- If no primary track is declared in `IDEA_SCOPE.md`, say **"primary track UNDECLARED"**
  and treat that as a gap with a cost — it is a real one, since the handbook makes depth
  on one track the stated winning strategy.

Do not invent alternative denominators (`/25`, `/30`) or report two competing totals. One
number, same basis every tick, so movement between ticks means something.
