"""The onboarding payload is one contract written in two languages.

`app/src/screens/setup/Consent.tsx` builds the body; `OnboardingBody` in
`api/caregiver/routes.py` declares what the endpoint reads. Nothing made them
agree, and twice they have not.

First, two routers both claimed `POST /app/onboarding`: the screen posted
snake_case at the one that never ran, so every real onboarding answered 422 on a
missing `parentName`. Then the merge that resolved it left
`api/tests/test_end_to_end.py` posting the *other* shape, and five tests in that
file failed on a 422 no source change had caused.

`extra="ignore"` is why this needs a test rather than a schema. It is the right
setting — an older app build must not 422 on a field it no longer sends — but it
also means a renamed or misspelt key is dropped in silence, and the value the
caregiver typed simply never arrives.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

os.environ.setdefault("OTP_PEPPER", "a-long-enough-test-pepper-value")
os.environ.setdefault("VOXIKIN_DB", tempfile.mktemp(suffix=".db"))

from api.caregiver.routes import OnboardingBody  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CONSENT_TSX = ROOT / "app/src/screens/setup/Consent.tsx"
POST_CALL = "authApi.post('/app/onboarding', {"


def posted_keys() -> set[str]:
    """The top-level keys of the object literal the screen posts.

    A depth counter rather than a TypeScript parser: only keys at depth 1 count,
    so the nested `medicines.map(...)` row keys and `meal_times` do not leak in.
    """
    source = CONSENT_TSX.read_text()
    start = source.index(POST_CALL) + len(POST_CALL) - 1
    depth, end = 0, None
    for i in range(start, len(source)):
        ch = source[i]
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
            if depth == 0:
                end = i
                break
    assert end is not None, "the posted object literal is not balanced"

    keys, depth = set(), 0
    for line in source[start + 1 : end].splitlines():
        stripped = line.strip()
        if depth == 0 and (m := re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*:", stripped)):
            keys.add(m.group(1))
        depth += sum(stripped.count(c) for c in "{[(") - sum(stripped.count(c) for c in "}])")
    return keys


@pytest.fixture(scope="module")
def sent() -> set[str]:
    assert CONSENT_TSX.exists(), CONSENT_TSX
    keys = posted_keys()
    assert keys, "no keys were parsed out of Consent.tsx — the shape of the call changed"
    return keys


def test_every_field_the_app_sends_is_one_the_endpoint_reads(sent):
    """A key the model does not declare is dropped in silence, and the value the
    caregiver typed never arrives."""
    assert sent <= set(OnboardingBody.model_fields), sent - set(OnboardingBody.model_fields)


def test_every_field_the_endpoint_requires_is_one_the_app_sends(sent):
    """A required field the app omits is a 422 — which is exactly how onboarding
    was broken, and the Python tests could not see it because they post their own
    dict rather than the screen's."""
    required = {n for n, f in OnboardingBody.model_fields.items() if f.is_required()}
    assert required <= sent, required - sent


def test_the_gates_are_actually_sent(sent):
    """Not merely declared. `schedule_confirmed` is the FR-4 sign-off and
    `consents` is the GAP-2 gate; the endpoint refuses without either, so an app
    that stopped sending them would fail every onboarding."""
    assert {"schedule_confirmed", "consents"} <= sent


def test_the_app_sends_no_caregiver_identity(sent):
    """The caregiver comes from the session cookie. `caregiver_name` is a display
    name the endpoint COALESCEs, not an identity — but a phone, an email or a
    verification flag in this body would be one, and reading identity out of the
    request body is what made the old handler exploitable."""
    assert not sent & {"phone", "email", "phoneVerified", "emailVerified", "caregiver_id"}


def test_the_end_to_end_test_posts_the_same_shape():
    """test_end_to_end.py walks the whole journey with its own literal, so it can
    drift from the screen without anything noticing — and after the feat/app merge
    it had, posting camelCase at a snake_case handler."""
    e2e = (ROOT / "api/tests/test_end_to_end.py").read_text()
    start = e2e.index("ONBOARDING = {")
    body = e2e[start : e2e.index("\n}\n", start)]
    keys = set(re.findall(r'^\s{4}"([a-zA-Z_]+)":', body, re.M))
    assert keys, "could not parse ONBOARDING out of test_end_to_end.py"
    assert keys <= set(OnboardingBody.model_fields), keys - set(OnboardingBody.model_fields)
