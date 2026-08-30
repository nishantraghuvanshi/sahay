"""What a plan costs. spec: FR-28 · docs/checklists/LANE-D-EVIDENCE.md

Prices live here and nowhere else on the server. The browser sends a plan *key*
and never an amount — a client-supplied amount is a free subscription for anyone
who opens devtools.

These three tiers are the ones already published on the landing page
(app/src/screens/landing/Landing.tsx). If they diverge, the landing page is
marketing and this file is what the buyer is actually charged, so this file wins
and the page is the bug.
"""

from __future__ import annotations

# Rupees are stored and compared in paise. A float rupee amount cannot represent
# 499.37 exactly, and the whole reconciliation scheme below depends on the last
# two digits being exact.
PLANS: dict[str, dict] = {
    "care": {
        "key": "care",
        "name": "Care",
        "paise": 49_900,
        "includes": [
            "Up to 2 dose slots a day",
            "Inbound line",
            "Caregiver app",
            "Escalations to your family",
        ],
    },
    "care_plus": {
        "key": "care_plus",
        "name": "Care+",
        "paise": 99_900,
        "includes": [
            "Unlimited dose slots",
            "Priority-medicine alerts",
            "Read-only handoff links",
        ],
    },
}

# One month, billed as a fixed 30 days rather than a calendar month. A calendar
# month makes 31 Jan a question with no good answer, and nothing in this product
# needs the renewal date to land on the same numbered day.
PERIOD_DAYS = 30

# How long an unpaid order holds its paise suffix. Long enough that a buyer can
# open their UPI app, find the account and type an amount; short enough that a
# tab left open at lunch does not reserve 499.37 all afternoon.
DEFAULT_WINDOW_MIN = 30


def price_paise(plan: str) -> int | None:
    entry = PLANS.get(plan)
    return entry["paise"] if entry else None
