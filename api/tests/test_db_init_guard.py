"""db.init() must refuse a URL-shaped DB_PATH before it can destroy anything.
spec: .superpowers/sdd/modularise-boundaries/task-4-brief.md, fix round 1
finding 2.

Pure stdlib + sqlite3, no FastAPI dependency — see test_schema_version.py's
module docstring for why this matters in the environment this was written
in.

`api/db.py::init()` used to run:

    if reset and DB_PATH.exists(): DB_PATH.unlink()

ABOVE assert_database_target(...). So `init(reset=True)` with a URL-shaped
VOXIKIN_DB deleted the file before refusing — the module's own docstring
claimed refusal happens "before anything is created", but deletion is not
creation, and the controller addendum explicitly says the evidence file
(agent/postgresql:/...) is not to be touched. Fixed by moving the guard to
the very first line of init(), before reset or anything else runs.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from api import db  # noqa: E402
from api.db_path import UnsupportedDatabaseTargetError  # noqa: E402


def test_init_reset_with_a_url_shaped_path_refuses_and_deletes_nothing(tmp_path, monkeypatch):
    # A file that already exists at the configured (bad) path — if the old
    # ordering bug were still present, `reset=True` would unlink this before
    # ever reaching the filesystem-path check. `Path("postgresql://a:b@c")`
    # is built as a RELATIVE path from the process's own cwd so it reproduces
    # agent/postgresql:/... in the real working tree exactly — the collapsed
    # single-slash form that assert_database_target once rejected while the
    # Node redactor still printed it in clear.
    monkeypatch.chdir(tmp_path)
    raw = "postgresql://kinvox:secret@localhost:5432/kinvox"
    existing = Path(raw)  # pathlib collapses "//" to "/" the moment this is built
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"not actually empty")

    monkeypatch.setattr(db, "DB_PATH", existing)
    monkeypatch.setenv("VOXIKIN_DB", raw)

    raised = False
    try:
        db.init(reset=True)
    except UnsupportedDatabaseTargetError:
        raised = True

    assert raised, "init(reset=True) with a URL-shaped path must raise UnsupportedDatabaseTargetError"
    assert existing.exists(), "the file must NOT have been deleted before the refusal"
    assert existing.read_bytes() == b"not actually empty"


def test_init_reset_with_a_legitimate_path_still_deletes_and_recreates(tmp_path, monkeypatch):
    # Control case: reset must still work for an ordinary path, proving the
    # guard didn't just block reset entirely.
    real_path = tmp_path / "real.db"
    real_path.write_bytes(b"stale contents")

    monkeypatch.setattr(db, "DB_PATH", real_path)
    monkeypatch.delenv("VOXIKIN_DB", raising=False)

    db.init(reset=True)

    assert real_path.exists()
    assert real_path.read_bytes() != b"stale contents"  # rebuilt as a real sqlite file
