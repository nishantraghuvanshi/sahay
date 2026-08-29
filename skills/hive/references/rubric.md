# The Hive — Scoring Rubric (verbatim)

Source: ApplyBee AI Hive Buildathon Builder Handbook, "Scoring Metrics".
Transcribed word-for-word. **Do not paraphrase these ladders when scoring.**
Quote the level text you are matching against.

## How to read L1–L5

> Each level raises the standard of proof. **Judges score the demonstrated product,
> not the pitch, architecture diagram, or number of APIs connected.**

| Level | Name | Definition |
|---|---|---|
| L1 | Floor | The parameter is absent, unproven, or present only in its most obvious form. |
| L2 | Baseline | A basic attempt is visible, but important gaps limit the claim. |
| L3 | Working | A credible middle standard is demonstrated with relevant evidence. |
| L4 | Strong | The parameter is distinctly strong and **survives realistic challenge**. |
| L5 | Exceptional | An exceptional benchmark that is **difficult to reproduce or dismiss**. |

> Read the complete description and example for the level. The headline is only a
> quick label; it is not enough to score the product by itself.

**Verification consent (T&C clause 09):** "By submitting, you consent to metric
verification. This includes read-only analytics access, database spot checks, and
contact checks with your signups. **Refusing verification zeroes that parameter.**"

A number you cannot let a judge verify is not a number. Score it as absent.

---

# TRACK PARAMETERS (pick ONE primary; depth beats breadth)

> **Builder Strategy:** Depth on your primary track beats thin execution across all three.

## Virality (Track 1)
*Social post reach, engagement (impressions, likes, shares, reactions), creative storytelling, viral potential.*

- **L1** — No social post or public distribution attempt. Zero external impressions or shareable content.
- **L2** — Basic text post created, but low engagement (under 100 impressions, minimal likes/reactions, basic copy).
- **L3** — Creative post on LinkedIn/X/Instagram with solid engagement (500+ impressions, active comments, screenshot proof submitted).
- **L4** — Strong viral response with high engagement (2,000+ impressions, multiple reshares/retweets, high audience interest and strong post storytelling).
- **L5** — Breakthrough viral post (10k+ impressions, widespread reshares by industry leaders, massive organic traffic & screenshot proof).

## Revenue (Track 2)
*Financial viability, monetization potential, GTM conversion, unit economics.*

- **L1** — No monetization strategy or business model defined. Pure theoretical concept without commercial path.
- **L2** — Generic subscription pricing mentioned, but lacking unit economics, target audience validation, or pricing logic.
- **L3** — Functional Stripe/UPI test checkout integration or clear pricing tier backed by defensible ROI for target buyers.
- **L4** — Proven willing-to-pay intent with real simulated transactions, pre-order signups, or explicit cost-reduction metric.
- **L5** — Immediate live revenue generated during the hackathon or validated unit economics with high LTV/CAC potential.

## Novelty (Track 3)
*How innovative, original, and creative is the technical architecture and user experience?*

- **L1** — Standard wrapper around a single LLM prompt or boilerplate template without unique technical contribution.
- **L2** — Minor cosmetic twist on an existing open-source repository or tutorial project.
- **L3** — Distinctive agentic workflow or novel UI pattern that solves a real user problem in an unconventional way.
- **L4** — Highly original combination of multi-agent loops, custom tools, dynamic state, and unique product framing.
- **L5** — Category-defining breakthrough that reframes how the problem is solved, producing an 'I didn't know AI could do that' moment.

---

# THE FIVE PRODUCT PARAMETERS (all projects scored on all five)

## Job-to-be-done completion
*Did the product produce the correct, usable outcome?*

- **L1** — 0 completed tasks. Demo only. The agent gives canned responses or talks through the workflow, but does not complete the declared job (no order checks, no database updates).
- **L2** — Less than 30% task success. The agent runs, but the output is broken, fake, incomplete, or unusable (e.g. tells user money has been reversed without checking payment record).
- **L3** — 50 to 70% task success on mocked, sandbox, or staged surfaces. The agent completes a useful part of the declared job and creates at least one usable artifact (sandbox CRM/Airtable/Notion).
- **L4** — 70 to 85% task success on a production-like demo workflow. The agent completes most of the declared job across a realistic workflow. Human review may still be needed for final approval.
- **L5** — 85%+ task success across a minimum of three repeated test cases. The agent completes the declared job end-to-end and produces a final usable output without judge/builder intervention.

## Memory and Context
*Does the product carry forward the right identity, history, task state, permissions, and business rules?*

- **L1** — Every interaction starts from zero. The product does not retain the current task, user identity, prior answers, document state, or business context. Any handoff or restart loses everything.
- **L2** — It remembers identifiers, but not the working context. The product can hold one or two fields such as a name, phone number, or case ID. It does not reliably retain the user's actual goal.
- **L3** — It maintains the complete current task for an authenticated user. The product knows who the user is, what they are allowed to access, and uses earlier answers instead of repeating questions.
- **L4** — It uses relevant history and carries context across sessions, channels, or handoffs. The next component continues without making the user restart. Authentication remains intact.
- **L5** — It delivers governed business continuity across the whole product. Combines current task, relevant history, and governing business rules. Context survives sessions, channels, tools, and handoffs.

## Creativity
*How uniquely and non-obviously was the problem solved?*

- **L1** — The build is the obvious first implementation. It closely reproduces a reference agent, idea-card flow, tutorial, or generic wrapper. Changing the logo, persona, or UI theme is not a creative contribution.
- **L2** — There is a twist, but it is cosmetic or loosely attached. The team adds one variation beyond the obvious build, but it does not materially change how the problem is understood or solved.
- **L3** — The solution contains one meaningful, non-obvious choice. A recognisable point of view that changes how the user solves the problem, rather than decorating the expected solution.
- **L4** — The solution is distinctive from end to end. Several original choices reinforce one another across the problem framing, interaction, and product workflow. Use of AI agent stack is purposeful.
- **L5** — The solution reframes what people thought the product could be. The idea produces a genuine 'I did not know you could solve it that way' reaction, unlocking a materially better possibility.

## Impact
*If this product did not exist—or was taken away—whose outcome gets worse, by how much, and how often?*

- **L1** — No credible impact case is articulated. The team describes the technology or a broad social good but cannot name who experiences the problem or what it costs.
- **L2** — The problem is real, but the value case is weak or unproven. The team names a user and a metric, but the frequency, current cost, or path is assumed. Value movement is below 5%.
- **L3** — There is a clear case for meaningful value. The team can defend who benefits, how often the problem occurs, and a plausible 5% to below 10% movement on one meaningful metric.
- **L4** — The product targets a major, measurable bottleneck. The team shows a defensible path to 10% to 30% movement on an important operating, revenue, cost, risk, or access metric.
- **L5** — The product addresses a top-priority problem with transformational value. Credible path to more than 30% movement or an equivalent step-change in cost, revenue, risk, or access.

## Delight
*At the user's real point of friction, does the product create confidence, clarity, and forward movement?*

- **L1** — The product mishandles the moment of friction. The user becomes more confused, anxious, or stuck. Hides uncertainty, offers false reassurance, or exposes raw system output.
- **L2** — The result is usable, but the care is generic. The product completes the happy path but does not respond to the user's actual concern or adapt the next step to the case.
- **L3** — The product removes the obvious friction. A first-time user can complete the main flow without builder intervention. Communicates status honestly and gives concrete next actions.
- **L4** — The product handles the user's hardest moment with judgment. Tells the truth without being alarming, reassures only where evidence supports it, and recovers without losing progress.
- **L5** — The product anticipates the pain point and stays with the user through resolution. Predicts the next concern, makes follow-up effortless, and keeps user informed.
