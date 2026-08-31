"""db_path.py — reject a configured database target neither runtime can open.
spec:
.superpowers/sdd/modularise-boundaries/task-4-brief.md, controller addendum.

Pure stdlib, no FastAPI dependency — see test_schema_version.py's module
docstring for why this matters in the environment this was written in.

The table of inputs lives in api/fixtures/db-path-cases.json, NOT here, and
agent/tests/db-path.test.js reads the same file. That fixture is the only
thing keeping api/db_path.py and agent/src/utils/db-path.js in step. They
were previously "kept in step by the tests on each side" and drifted anyway —
Node keying redaction on "://" and this file on ":/" — so Node printed
`postgresql:/user:PASSWORD@host/db` verbatim out of the very guard meant to
protect it, while this side mangled the real Windows path
`C:/Users/x/data.db` into `C://<redacted>`. Neither suite ever ran the
other's inputs, and four review rounds passed over it. Add a case to the
fixture, never to one side.
"""
import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from api.db_path import (  # noqa: E402
    UnsupportedDatabaseTargetError,
    assert_database_target,
    is_remote_target,
    redact_credentials,
)

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "db-path-cases.json"
FIXTURE = json.loads(FIXTURE_PATH.read_text())
CASES = FIXTURE["cases"]
REDOS = FIXTURE["redos"]


def _ids(cases):
    return [c["label"] for c in cases]


class TestTheSharedFixture:
    VERDICTS = ("path", "remote", "refused")

    def test_is_present_and_non_trivial(self):
        # An empty or missing fixture must not read as a pass.
        assert len(CASES) >= 30, f"expected 30+ shared cases, got {len(CASES)}"
        for verdict in self.VERDICTS:
            assert any(c["verdict"] == verdict for c in CASES), (
                f"no {verdict} cases — all three verdicts must be exercised"
            )
        for case in CASES:
            assert case["verdict"] in self.VERDICTS, f"unknown verdict on {case['label']}"
        assert REDOS

    @pytest.mark.parametrize(
        "required",
        [
            "postgresql://kinvox:SECRETPW@localhost:5432/kinvox",
            "postgresql:/kinvox:SECRETPW@localhost:5432/kinvox",
            ":/user:SECRET@host",
            "://user:SECRET@host",
            "1abc:/user:SECRET@host",
            "$$$://user:SECRET@host",
            "C:/Users/x/data.db",
            # The deployed case: refusing this, or coarsening it in the boot
            # log, is what the allowlist exists to prevent.
            "libsql://sahay-prod.turso.io",
            "libsql://tok:SECRETPW@sahay-prod.turso.io",
            "libsql://sahay-prod.turso.io/?authToken=SECRETTOKEN",
        ],
    )
    def test_carries_the_shapes_finding_1_named_and_the_deployed_remote_shapes(self, required):
        assert required in {c["input"] for c in CASES}


class TestRedactCredentialsAgainstTheFixture:
    @pytest.mark.parametrize("case", CASES, ids=_ids(CASES))
    def test_every_shared_case(self, case):
        got = redact_credentials(case["input"])
        assert got == case["expected"], f"{case['label']}: {got!r} != {case['expected']!r}"
        if case["verdict"] == "path":
            # Not merely "equal": the same string, so a real path can never
            # be corrupted into pointing at a different database.
            assert got == case["input"]
            return
        for forbidden in case.get("forbidden", []):
            assert forbidden not in got, f"{case['label']}: {forbidden!r} survived into {got!r}"
        # The structural guarantee, checked by construction rather than by
        # pattern: userinfo cannot exist in the output at all — not even for
        # an accepted remote target, whose userinfo is dropped rather than kept.
        assert "@" not in got, f"{case['label']}: an authority delimiter survived into {got!r}"


class TestAssertDatabaseTargetAgainstTheFixture:
    @pytest.mark.parametrize("case", CASES, ids=_ids(CASES))
    def test_every_shared_case(self, case):
        if case["verdict"] != "refused":
            assert_database_target(case["input"], "VOXIKIN_DB")  # must not raise
            return
        with pytest.raises(UnsupportedDatabaseTargetError) as exc_info:
            assert_database_target(case["input"], "VOXIKIN_DB")
        message = str(exc_info.value)
        # Finding 1's self-inflicted half: the guard rejected on ":/+" but
        # rendered the offending value through a redactor that understood
        # only "://", so the password it exists to protect was printed in
        # clear. The message must carry the SAME redaction the fixture pins.
        assert case["expected"] in message, f"{case['label']}: not rendered through the redactor"
        for forbidden in case.get("forbidden", []):
            assert forbidden not in message, f"{case['label']}: leaked into the message"
        assert "@" not in message


class TestIsRemoteTargetAgainstTheFixture:
    # One definition of "remote" for the whole product: api/db.py decides it
    # from TURSO_DATABASE_URL being set, but the SHAPE of a reachable URL is
    # this function's answer and the Node adapter asks its mirror. The fixture
    # pins the same answer on both sides.
    @pytest.mark.parametrize("case", CASES, ids=_ids(CASES))
    def test_every_shared_case(self, case):
        assert is_remote_target(case["input"]) is (case["verdict"] == "remote")


class TestMessageShapeNotSharedWordingIsPerRuntime:
    def test_error_names_the_variable_that_was_set(self):
        with pytest.raises(UnsupportedDatabaseTargetError, match="VOXIKIN_DB"):
            assert_database_target("postgresql://a:b@c/d", "VOXIKIN_DB")

    def test_falls_back_to_a_generic_label_when_no_variable_name_given(self):
        with pytest.raises(UnsupportedDatabaseTargetError, match="configured database path"):
            assert_database_target("postgresql://a:b@c/d")

    def test_the_refusal_names_the_schemes_that_would_have_been_accepted(self):
        with pytest.raises(UnsupportedDatabaseTargetError, match=r"libsql://"):
            assert_database_target("postgresql://a:b@c/d", "VOXIKIN_DB")


class TestCoercionIsLanguageSpecificSoNotShareable:
    # str(None) is 'None' but String(null) is 'null'; JS's `undefined` has no
    # Python counterpart. These cannot live in the shared fixture, so each
    # side asserts "never throws" locally.
    @pytest.mark.parametrize("value", [None, 5, 0, True], ids=["None", "an int", "zero", "a bool"])
    def test_never_throws(self, value):
        redact_credentials(value)  # must not raise


class TestNoReDoS:
    @staticmethod
    def _best_ms(fn, runs=5):
        # Best of five: the budgets are tight enough that a single unlucky GC
        # or scheduler slice would dominate, and the thing under test is
        # whether the algorithm is linear, not how busy the machine is.
        best = float("inf")
        for _ in range(runs):
            start = time.perf_counter()
            fn()
            best = min(best, (time.perf_counter() - start) * 1000)
        return best

    @pytest.mark.parametrize("case", REDOS, ids=_ids(REDOS))
    def test_within_the_shared_budget(self, case):
        text = case.get("prefix", "") + case["unit"] * case["count"] + case["suffix"]
        ms = self._best_ms(lambda: redact_credentials(text))
        assert ms < case["max_ms"], f"{case['label']}: took {ms:.3f}ms, budget {case['max_ms']}ms"
