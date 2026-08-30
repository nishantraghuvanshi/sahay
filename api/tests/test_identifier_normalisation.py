"""One phone number, one spelling — across signup and login both.

The bug this pins: `/auth/otp/start` normalised its destination and
`/auth/login` did a bare `.strip()`. Two halves of auth disagreeing about how a
number is written meant a caregiver could sign up, then be told their password
did not match — while typing the number exactly the way the login field's own
placeholder shows it, spaces and all.
"""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ.setdefault("OTP_PEPPER", "a-long-enough-test-pepper-value")

from api.auth.otp import Channel, normalise, normalise_identifier, normalise_phone  # noqa: E402

E164 = "+919876543210"


@pytest.mark.parametrize(
    "typed",
    [
        "+919876543210",
        "+91 98765 43210",   # exactly what the login placeholder shows
        "+91-98765-43210",
        "+91 (98765) 43210",
        " +919876543210 ",
        "919876543210",
        "9876543210",
        "98765 43210",
        "09876543210",       # trunk prefix
        "00919876543210",    # international prefix
    ],
)
def test_every_way_a_number_gets_typed_reaches_one_spelling(typed):
    assert normalise_phone(typed) == E164


def test_a_number_it_cannot_confidently_rewrite_is_left_alone():
    """Better to fail validation downstream than to invent a subscriber. A
    9-digit string is not a mobile and must not become one by having +91 glued
    to the front."""
    assert normalise_phone("12345") == "12345"
    assert normalise_phone("987654321") == "987654321"
    # Indian mobiles start 6-9. A 10-digit number starting 5 is not one.
    assert normalise_phone("5876543210") == "5876543210"


def test_a_foreign_number_survives_untouched():
    assert normalise_phone("+14155552671") == "+14155552671"


def test_email_and_phone_are_told_apart_by_the_at_sign():
    """The login box takes either, so it has to decide which before normalising."""
    assert normalise_identifier("  Test@Example.COM ") == "test@example.com"
    assert normalise_identifier("+91 98765 43210") == E164


def test_the_otp_channel_helper_normalises_phones_too():
    """`normalise` is what /auth/otp/start uses. Before the fix it only trimmed,
    so a spaced number failed the E164 check and the endpoint returned its
    generic success while sending nothing at all — a silent dead end."""
    assert normalise(Channel.sms, "+91 98765 43210") == E164
    assert normalise(Channel.email, " A@B.com ") == "a@b.com"
