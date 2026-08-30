"""The UPI deep link, and the reference the buyer reads back to us.

NPCI's `upi://pay` URI is the whole integration. Every UPI app on the buyer's
phone — BHIM, GPay, PhonePe, Paytm — handles it, so this works without any of
them knowing Kinvox exists.

Deliberately NOT sent: `tr` (transaction reference) and `mc` (merchant category).
Those are merchant-mode parameters, and several apps reject a personal VPA that
sends them with an "invalid merchant" error rather than opening the payment
sheet. The order reference travels in `tn` instead, where it is only a hint to
the human reading their statement — the amount is what actually identifies the
order (api/schema.sql, `payments_open_amount_unique`).
"""

from __future__ import annotations

import random
from urllib.parse import quote

# No I, O, 0 or 1. The reference gets read off a screen and typed into a chat
# message, and those four are the pairs people get wrong.
_REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_ref() -> str:
    return "KVX-" + "".join(random.choices(_REF_ALPHABET, k=4))


def rupees(paise: int) -> str:
    """Paise -> the two-decimal string a UPI app expects. Never a float: 49937/100
    is 499.37000000000006 in binary floating point, and some apps take that
    literally and reject the amount."""
    return f"{paise // 100}.{paise % 100:02d}"


def intent_url(*, vpa: str, payee_name: str, amount_paise: int, ref: str) -> str:
    """The `upi://pay` URI, for a QR code on desktop or a tap on a phone."""
    params = [
        ("pa", vpa),
        ("pn", payee_name),
        ("am", rupees(amount_paise)),
        ("cu", "INR"),
        ("tn", f"Kinvox {ref}"),
    ]
    query = "&".join(f"{k}={quote(str(v), safe='')}" for k, v in params)
    return f"upi://pay?{query}"
