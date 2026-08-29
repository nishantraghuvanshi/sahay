"""Caregiver passwords: hash, verify, and the rules around guessing.

scrypt from the standard library — no new dependency, and memory-hard, which is
what makes a stolen `caregivers` dump expensive to crack rather than a weekend's
GPU work. A plain SHA-256 of a password is close to storing it in the clear:
people pick from a small space, and a fast hash lets an attacker walk it.

The OTP beside this dies after five wrong tries. A password that allowed
unlimited attempts would be the weaker of the two secrets, so it gets a lockout
of its own.
"""

from __future__ import annotations

import hmac
import secrets
from datetime import UTC, datetime, timedelta

# OWASP's floor for scrypt. n is the work factor — raising it costs an attacker
# exactly what it costs us, but we pay it once per login and they pay it per guess.
SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SALT_BYTES = 16
KEY_BYTES = 32

MIN_LENGTH = 8
MAX_LENGTH = 128  # a megabyte password is a denial-of-service on a memory-hard KDF

MAX_FAILED_LOGINS = 5
LOCKOUT = timedelta(minutes=15)


def hash_password(password: str) -> tuple[bytes, bytes]:
    """Returns (hash, salt). The salt is per-caregiver, so two people with the
    same password do not share a digest and one cracked row does not reveal the
    other."""
    import hashlib

    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.scrypt(
        password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=KEY_BYTES
    )
    return digest, salt


def verify_password(password: str, digest: bytes, salt: bytes) -> bool:
    import hashlib

    candidate = hashlib.scrypt(
        password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=KEY_BYTES
    )
    return hmac.compare_digest(candidate, digest)


def problem_with(password: str) -> str | None:
    """None when acceptable. Length only — no character-class rules, which push
    people towards `Passw0rd!` and are worse than a longer passphrase."""
    if len(password) < MIN_LENGTH:
        return "password_too_short"
    if len(password) > MAX_LENGTH:
        return "password_too_long"
    return None


def is_locked(locked_until: datetime | None) -> bool:
    return locked_until is not None and locked_until > datetime.now(UTC)


def lockout_until() -> datetime:
    return datetime.now(UTC) + LOCKOUT
