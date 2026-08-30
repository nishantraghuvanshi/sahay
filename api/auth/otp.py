"""One-time codes: generate, hash, verify.

Nothing here talks to HTTP or to a delivery channel — it owns the code and the
rules around it, so the rules can be tested without a carrier or a socket.

Three properties this file exists to hold:
  1. The code is never stored, logged or returned. Only HMAC-SHA256(code, pepper).
  2. A code dies on success and on the final failed attempt. A burnt code is
     never a candidate again, so "keep guessing until it works" cannot work.
  3. The attempt counter is written before the comparison, so a crash, a timeout
     or a dropped connection mid-verify costs an attempt rather than granting a
     free one.
"""

from __future__ import annotations

import hashlib
import hmac
import uuid
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import Enum


from api.config import Settings

CODE_DIGITS = 6


class Channel(str, Enum):
    sms = "sms"
    email = "email"


class VerifyResult(str, Enum):
    ok = "ok"
    no_code = "no_code"          # nothing outstanding for this destination
    expired = "expired"
    too_many_attempts = "too_many_attempts"
    wrong_code = "wrong_code"


@dataclass(frozen=True)
class SendDecision:
    """What `start` should do. `code` is None when the caller must not send."""

    send: bool
    resend_after_s: int
    code: str | None = None


def generate_code() -> str:
    """`secrets`, never `random` — the latter is a Mersenne Twister and its
    output is reconstructible from a handful of observed values."""
    return f"{secrets.randbelow(10**CODE_DIGITS):0{CODE_DIGITS}d}"


def hash_code(code: str, pepper: str) -> str:
    """Hex, not raw bytes. auth_otp.code_hash is BYTEA in the Postgres schema
    this came from and TEXT here; handing sqlite3 a bytes value for a TEXT
    column stores it as a decoded string and compare_digest then never matches
    on the way back — a wrong code and a right code would both fail."""
    return hmac.new(pepper.encode(), code.encode(), hashlib.sha256).hexdigest()


def code_matches(code: str, code_hash: str, pepper: str) -> bool:
    # compare_digest, not ==. A byte-by-byte early exit leaks the correct prefix
    # through timing, which turns 10^6 guesses into about 60.
    return hmac.compare_digest(hash_code(code, pepper), code_hash)


def normalise(channel: Channel, destination: str) -> str:
    """One destination must have exactly one spelling, or the rate limiter and
    the lookup index disagree about whether two rows are the same person."""
    d = destination.strip()
    return d.lower() if channel is Channel.email else d


# --------------------------------------------------------------------- issue


async def prepare_send(
    conn,
    settings: Settings,
    channel: Channel,
    destination: str,
    request_ip: str | None,
) -> SendDecision:
    """Decide whether to issue a code, and insert it if so.

    Over a limit this returns `send=False` with the remaining cooldown. The
    caller still answers `{ok: true}` — a caller who can tell "rate limited" from
    "sent" can also tell "known number" from "unknown", which is the enumeration
    oracle we are avoiding.
    """
    now = datetime.now(UTC)
    hour_ago = now - timedelta(hours=1)

    last_sent_raw: str | None = await conn.fetchval(
        "SELECT max(created_at) FROM auth_otp WHERE channel = $1 AND destination = $2",
        channel.value,
        destination,
    )
    if last_sent_raw is not None:
        # TEXT column: parse before arithmetic. asyncpg handed back a datetime.
        last_sent_at = datetime.fromisoformat(last_sent_raw)
        elapsed = (now - last_sent_at).total_seconds()
        if elapsed < settings.otp_resend_cooldown_s:
            return SendDecision(False, int(settings.otp_resend_cooldown_s - elapsed))

    per_destination: int = await conn.fetchval(
        "SELECT count(*) FROM auth_otp "
        "WHERE channel = $1 AND destination = $2 AND created_at > $3",
        channel.value,
        destination,
        hour_ago.isoformat(),
    )
    if per_destination >= settings.otp_max_per_destination_hour:
        return SendDecision(False, settings.otp_resend_cooldown_s)

    if request_ip:
        per_ip: int = await conn.fetchval(
            "SELECT count(*) FROM auth_otp WHERE request_ip = $1 AND created_at > $2",
            request_ip,
            hour_ago.isoformat(),
        )
        if per_ip >= settings.otp_max_per_ip_hour:
            return SendDecision(False, settings.otp_resend_cooldown_s)

    # A bypass number gets the fixed code, and the row is written exactly as a
    # real one: same hash, same expiry, same attempt budget. Only the carrier
    # hop is skipped, so the demo path and the production path share every rule.
    is_bypass = (
        settings.phone_is_bypassed(destination)
        if channel is Channel.sms
        else settings.email_is_bypassed(destination)
    )
    code = settings.dev_otp_bypass_code if is_bypass else generate_code()

    # Supersede anything still outstanding. Without this, a resend leaves the
    # previous code live and doubles the guessing surface for its full TTL.
    await conn.execute(
        "UPDATE auth_otp SET consumed_at = $3 "
        "WHERE channel = $1 AND destination = $2 AND consumed_at IS NULL",
        channel.value,
        destination,
        now.isoformat(),
    )
    # id and created_at supplied: no gen_random_uuid()/now() defaults here, and
    # a TEXT primary key takes NULL without complaint.
    await conn.execute(
        "INSERT INTO auth_otp "
        "(id, channel, destination, code_hash, expires_at, request_ip, created_at) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7)",
        str(uuid.uuid4()),
        channel.value,
        destination,
        hash_code(code, settings.otp_pepper),
        (now + timedelta(minutes=settings.otp_ttl_min)).isoformat(),
        request_ip,
        now.isoformat(),
    )
    return SendDecision(
        send=not is_bypass,
        resend_after_s=settings.otp_resend_cooldown_s,
        code=code,
    )


# -------------------------------------------------------------------- verify


async def verify_code(
    conn,
    settings: Settings,
    channel: Channel,
    destination: str,
    code: str,
) -> VerifyResult:
    """Check `code` against the newest live row, consuming attempts.

    Two racing verifies of the same destination must burn two attempts rather
    than both read the same counter and each see one. Postgres needed FOR UPDATE
    to guarantee that; SQLite takes a single write lock per connection, so the
    UPDATE that spends the attempt already serialises them.
    """
    row = await conn.fetchrow(
        "SELECT id, code_hash, expires_at, attempts FROM auth_otp "
        "WHERE channel = $1 AND destination = $2 AND consumed_at IS NULL "
        # FOR UPDATE dropped: SQLite serialises writers with a single write
        # lock, so the race it guarded against cannot interleave here.
        "ORDER BY created_at DESC LIMIT 1",
        channel.value,
        destination,
    )
    if row is None:
        return VerifyResult.no_code

    now_iso = datetime.now(UTC).isoformat()
    if datetime.fromisoformat(row["expires_at"]) <= datetime.now(UTC):
        await conn.execute("UPDATE auth_otp SET consumed_at = $2 WHERE id = $1", row["id"], now_iso)
        return VerifyResult.expired

    if row["attempts"] >= settings.otp_max_attempts:
        await conn.execute("UPDATE auth_otp SET consumed_at = $2 WHERE id = $1", row["id"], now_iso)
        return VerifyResult.too_many_attempts

    # Spend the attempt first. If anything below this line fails to complete,
    # the guess must still have cost something.
    attempts = await conn.fetchval(
        "UPDATE auth_otp SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts",
        row["id"],
    )

    if not code_matches(code, row["code_hash"], settings.otp_pepper):
        if attempts >= settings.otp_max_attempts:
            await conn.execute(
                "UPDATE auth_otp SET consumed_at = $2 WHERE id = $1", row["id"], now_iso
            )
        return VerifyResult.wrong_code

    await conn.execute("UPDATE auth_otp SET consumed_at = $2 WHERE id = $1", row["id"], now_iso)
    return VerifyResult.ok
