# The Clock — what is still winnable at hour N

T-ZERO = **6:00 PM IST, Aug 29**. Code freeze = **6:00 PM IST, Aug 30** (T+24).
Submission window opens 5:30 PM (T+23.5). Late = not scored, no appeal.

## Why the clock is a scoring input

Parameters do not decay at the same rate. Two are **time-locked** — after a certain
hour, no amount of work raises them. The triage step must therefore weight by
*remaining winnable headroom*, not by raw point gap.

| Parameter | Lever | Dead after | Why |
|---|---|---|---|
| **Virality** | Post must be live and accumulating | ~T+8 | L3 needs 500+ impressions, L4 needs 2,000+. Organic reach takes hours to compound. A post at T+20 has ~4h to travel and will land L2 regardless of copy quality. |
| **Creativity** | The framing of the problem | ~T+3 | L3+ requires a "meaningful, non-obvious choice" in *how the problem is understood*. That is the idea, not the implementation. Changing it at T+15 means rebuilding. |
| **Novelty** | Architecture + product framing | ~T+6 | L4 wants "multi-agent loops, custom tools, dynamic state" reinforcing one framing. The shape has to be chosen before the code is written around it. |
| **Impact** | Baseline research + metric choice | ~T+18 | Mostly a defensibility artifact, not code. Cheap late, but needs a real source. |
| **Memory & Context** | Persistence + auth + continuity | ~T+20 | Code. Buildable late, but L4/L5 need cross-session proof, which needs a session to have happened. |
| **JTBD** | Repeatability harness + real integrations | ~T+21 | Code + test runs. The single cheapest late L5 — see below. |
| **Delight** | Failure-path handling | ~T+22 | Mostly prompt + copy work on the unhappy path. Cheapest late lever of all. |
| **Revenue** | Checkout + a payer | ~T+20 | Test-mode checkout is ~1h. Finding a real payer is the hard part. |

## The asymmetry to exploit

**JTBD L5 is the cheapest L5 on the board.** It asks for "85%+ task success across a
minimum of three repeated test cases … without judge/builder intervention." That is a
script and three logged runs. Most teams will demo *once*, live, and land L3–L4 because
a single successful run cannot demonstrate a success *rate*.

Build the harness early and it pays twice: it is your regression signal while you build,
and it is your L5 artifact at submission. Same file.

## Fixed calendar gates

| Time | T+ | Gate |
|---|---|---|
| Aug 29, 6:00 PM | T+0 | Kickoff. Tracks unlock. |
| Aug 29, ~9:00 PM | T+3 | **Framing lock.** Idea + primary track committed. Reopening after this costs more than it returns. |
| Aug 30, ~2:00 AM | T+8 | **Virality gate.** Post live by now or write Virality off as a scoring track. |
| Aug 30, 8:45 AM–1:30 PM | T+15–19.5 | Longest uninterrupted build block. Reserve for the highest-point build item. |
| Aug 30, 3:00 PM | T+21 | **Evidence freeze.** Stop building. Capture runs, screenshots, transcripts. |
| Aug 30, ~4:30 PM | T+22.5 | **Fallback recording done.** Handbook: "Have a recording ready if the live run drops." |
| Aug 30, 5:30–6:00 PM | T+23.5–24 | Submission window. Repo URL + demo video/live link + virality screenshots. |
| Aug 30, 6:00 PM | T+24 | Hard freeze. |

## Tick cadence

Do not tick on a timer alone — tick on **state change or gate approach**:

- After any milestone that could move a level (a working integration, a captured run, a post going live)
- At each fixed gate above
- Whenever the human asks "where are we?"

A tick with no new evidence since the last one should say so and stop, not re-litigate
the same scorecard. Repeated identical scores are a signal to change *what you are
building*, not to score again.
