"""Remove the seeded demo household from a database that already has one.

Seeding is opt-in now (api/db.py::seed_enabled), so a fresh database never gets
this data. A database created before that change still holds it: caregiver
"Shubh", patient "Sharma", her medicines and a week of calls and alerts. While
the app read a client-side mock that was harmless scaffolding; now that every
screen reads the real API it is a fabricated family sitting in a health record.

Real accounts are left alone. Only the two fixture ids below are touched, so
running this against a database with real caregivers in it removes the demo and
nothing else.

    python scripts/drop_seed.py            # show what would go
    python scripts/drop_seed.py --apply    # do it, after writing a .bak
"""

import shutil
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api import db  # noqa: E402

# From scripts/mock-api.json. Hard-coded rather than "whatever looks like a
# demo": a heuristic that guesses wrong here deletes a real family's medicines.
SEED_CAREGIVER = "c1000000-0000-4000-8000-000000000001"
SEED_PATIENT = "p1000000-0000-4000-8000-000000000001"

# Children before parents. PRAGMA foreign_keys is on, and handoffs point at
# intake_records, which point at the patient.
PLAN = [
    ("handoffs",
     "intake_record_id IN (SELECT id FROM intake_records WHERE patient_id = ?)", SEED_PATIENT),
    ("escalations", "patient_id = ?", SEED_PATIENT),
    ("intake_records", "patient_id = ?", SEED_PATIENT),
    ("observations", "patient_id = ?", SEED_PATIENT),
    ("dose_events", "patient_id = ?", SEED_PATIENT),
    ("call_sessions", "patient_id = ?", SEED_PATIENT),
    ("medication_changes", "patient_id = ?", SEED_PATIENT),
    ("escalation_contacts", "patient_id = ?", SEED_PATIENT),
    ("medications", "patient_id = ?", SEED_PATIENT),
    ("patients", "id = ?", SEED_PATIENT),
    ("auth_sessions", "caregiver_id = ?", SEED_CAREGIVER),
    ("caregivers", "id = ?", SEED_CAREGIVER),
]


def main() -> int:
    apply = "--apply" in sys.argv
    path = db.DB_PATH
    if not path.exists():
        print(f"no database at {path} — nothing to do")
        return 0

    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")

    print(f"database: {path}\n")
    total = 0
    for table, where, arg in PLAN:
        try:
            n = con.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", (arg,)).fetchone()[0]
        except sqlite3.OperationalError as exc:
            print(f"  skip {table}: {exc}")
            continue
        if n:
            print(f"  {table}: {n}")
            total += n

    if not total:
        print("  no seeded rows found")
        return 0

    if not apply:
        print(f"\n{total} rows would be deleted. Re-run with --apply to do it.")
        return 0

    backup = path.with_suffix(path.suffix + ".bak")
    shutil.copy2(path, backup)
    print(f"\nbackup: {backup}")

    for table, where, arg in PLAN:
        try:
            con.execute(f"DELETE FROM {table} WHERE {where}", (arg,))
        except sqlite3.OperationalError:
            pass
    con.commit()

    broken = con.execute("PRAGMA foreign_key_check").fetchall()
    print("foreign keys:", "clean" if not broken else broken)

    print("\nremaining caregivers:")
    for r in con.execute("SELECT id, name, phone_e164, email FROM caregivers"):
        print("  ", dict(r))
    print("remaining patients:", con.execute("SELECT COUNT(*) FROM patients").fetchone()[0])
    con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
