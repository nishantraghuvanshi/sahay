"""Opaque sessions and the cookie that carries them.

Opaque, not JWT: a session must die the moment it is revoked, and a signed token
that verifies without a database read cannot be revoked at all. Nothing here
needs stateless verification — the API touches Postgres on every request anyway.

The raw token exists only in the caregiver's cookie. The database holds sha256
of it, so a dump of `auth_sessions` yields no usable login.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import asyncpg
from fastapi import Request, Response

from api.config import Settings

TOKEN_BYTES = 32  # 256 bits, URL-safe — same order as the handoff token (TRD §11)

# Below this much remaining life, a request slides the expiry forward. Rewriting
# the row on every single request would make a read-heavy screen a write load.
SLIDE_WHEN_REMAINING = timedelta(days=7)


@dataclass(frozen=True)
class Caregiver:
    id: str
    name: str
    phone_e164: str
    email: str | None
    relationship: str | None
    phone_verified_at: datetime | None
    email_verified_at: datetime | None

    def as_json(self) -> dict:
        return {
            "id": str(self.id),
            "name": self.name,
            "phone_e164": self.phone_e164,
            "email": self.email,
            "relationship": self.relationship,
            "phone_verified": self.phone_verified_at is not None,
            "email_verified": self.email_verified_at is not None,
        }


def _hash(token: str) -> bytes:
    # Plain sha256, not HMAC: the token is 256 bits of CSPRNG output, so there is
    # no low-entropy input for a pepper to protect. Speed is a feature here —
    # this runs on every authenticated request.
    return hashlib.sha256(token.encode()).digest()


async def issue(
    conn: asyncpg.Connection,
    settings: Settings,
    caregiver_id: str,
    user_agent: str | None,
) -> str:
    token = secrets.token_urlsafe(TOKEN_BYTES)
    await conn.execute(
        "INSERT INTO auth_sessions (caregiver_id, token_hash, expires_at, user_agent) "
        "VALUES ($1, $2, $3, $4)",
        caregiver_id,
        _hash(token),
        datetime.now(UTC) + timedelta(days=settings.session_ttl_days),
        (user_agent or "")[:500],
    )
    return token


async def resolve(conn: asyncpg.Connection, token: str) -> Caregiver | None:
    row = await conn.fetchrow(
        """
        SELECT s.id AS session_id, s.expires_at,
               c.id, c.name, c.phone_e164, c.email, c.relationship,
               c.phone_verified_at, c.email_verified_at
          FROM auth_sessions s
          JOIN caregivers c ON c.id = s.caregiver_id
         WHERE s.token_hash = $1
           AND s.revoked_at IS NULL
           AND s.expires_at > now()
        """,
        _hash(token),
    )
    if row is None:
        return None

    await conn.execute(
        "UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1", row["session_id"]
    )
    return Caregiver(
        id=str(row["id"]),
        name=row["name"],
        phone_e164=row["phone_e164"],
        email=row["email"],
        relationship=row["relationship"],
        phone_verified_at=row["phone_verified_at"],
        email_verified_at=row["email_verified_at"],
    )


async def slide_if_stale(conn: asyncpg.Connection, settings: Settings, token: str) -> None:
    await conn.execute(
        "UPDATE auth_sessions SET expires_at = now() + ($2 || ' days')::interval "
        "WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at < now() + $3",
        _hash(token),
        str(settings.session_ttl_days),
        SLIDE_WHEN_REMAINING,
    )


async def revoke(conn: asyncpg.Connection, token: str) -> None:
    await conn.execute(
        "UPDATE auth_sessions SET revoked_at = now() "
        "WHERE token_hash = $1 AND revoked_at IS NULL",
        _hash(token),
    )


# --------------------------------------------------------------------- cookie


def set_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.session_ttl_days * 24 * 3600,
        httponly=True,  # no page script can read it, so an XSS cannot exfiltrate it
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path="/",
    )


def clear_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        key=settings.session_cookie_name,
        path="/",
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
    )


def token_from(request: Request, settings: Settings) -> str | None:
    return request.cookies.get(settings.session_cookie_name)
