"""spec: TRD §3

Repository layer. CRUD only — no business logic.

One asyncpg pool for the process, opened in the app lifespan. Handlers take a
connection out of it; nothing here decides anything.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg

from api.config import get_settings

_pool: asyncpg.Pool | None = None


async def open_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        settings = get_settings()
        _pool = await asyncpg.create_pool(
            settings.database_url,
            min_size=1,
            max_size=10,
            # The tool contract has a 3s hard timeout (TRD §5.1); a query that
            # outlives it can only make the agent stall, so cap below it.
            command_timeout=2.5,
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("DB pool not open — call open_pool() in the app lifespan")
    return _pool


@asynccontextmanager
async def connection() -> AsyncIterator[asyncpg.Connection]:
    async with pool().acquire() as conn:
        yield conn


@asynccontextmanager
async def transaction() -> AsyncIterator[asyncpg.Connection]:
    """All-or-nothing. Onboarding writes a patient and its medicines together;
    a patient with half a prescription is worse than no patient."""
    async with pool().acquire() as conn, conn.transaction():
        yield conn
