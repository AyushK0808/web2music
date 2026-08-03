"""
Guards the three places the audio_cache schema is written down against
drifting apart:

  1. ../../docker/init.sql    -- what a FRESH postgres volume gets
  2. d5_cache_local.SCHEMA_COLUMNS -- what ensure_schema() repairs an EXISTING
                                     volume to
  3. save_to_cache()'s INSERT -- what actually gets written per clip

They drifted before, and the failure mode was nasty precisely because nothing
crashed at startup: init.sql grew `valence`/`arousal`/`intensity`/etc. to match
a widened INSERT, but Postgres only runs /docker-entrypoint-initdb.d on an
empty data directory, so every dev with an older db-data volume kept the
original 12-column table. Each /generate then produced a real clip, failed the
INSERT with `column "valence" ... does not exist`, got caught by main.py's
save_to_cache handler, and returned a fallback clip -- forever, because a cache
that can never be written can never be hit.
"""
import os
import re

import pytest

import d5_cache_local

INIT_SQL = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "docker", "init.sql",
)

# Columns the table always has and that ensure_schema() creates up front rather
# than ALTERing in -- they're NOT NULL, so they cannot be added to a table that
# already has rows anyway.
BASE_COLUMNS = {"id", "cache_key", "audio_url"}


def _init_sql_text():
    with open(INIT_SQL, encoding="utf-8") as f:
        return f.read()


def _create_table_columns(sql):
    body = re.search(r"CREATE TABLE IF NOT EXISTS audio_cache\s*\((.*?)\n\);", sql, re.S).group(1)
    return [
        m.group(1)
        for m in (re.match(r"\s*([a-z_]+)\s+\S", line) for line in body.splitlines())
        if m
    ]


def _alter_table_columns(sql):
    return re.findall(r"ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS ([a-z_]+)", sql)


def _insert_columns():
    """The column list from save_to_cache()'s INSERT statement."""
    import inspect

    source = inspect.getsource(d5_cache_local.save_to_cache)
    body = re.search(r"INSERT INTO audio_cache\s*\((.*?)\)\s*VALUES", source, re.S).group(1)
    return [c.strip() for c in body.replace("\n", " ").split(",") if c.strip()]


def test_init_sql_create_and_alter_lists_agree():
    """
    Every nullable column in the CREATE TABLE must also have an ALTER ... ADD
    COLUMN IF NOT EXISTS line, or a stale volume silently misses it -- which is
    the original bug. The reverse must hold too, or a fresh volume misses it.
    """
    sql = _init_sql_text()
    created = set(_create_table_columns(sql)) - BASE_COLUMNS
    altered = set(_alter_table_columns(sql))

    assert created == altered, (
        "docker/init.sql's CREATE TABLE and ALTER TABLE blocks disagree.\n"
        f"  in CREATE but never ALTERed (stale volumes won't get these): {sorted(created - altered)}\n"
        f"  ALTERed but not in CREATE (fresh volumes won't get these):   {sorted(altered - created)}"
    )


def test_ensure_schema_covers_every_init_sql_column():
    """
    ensure_schema() is what repairs an existing dev volume. If init.sql grows a
    column and SCHEMA_COLUMNS doesn't, dev DBs created before the change never
    gain it and every cache write fails.
    """
    sql_columns = set(_create_table_columns(_init_sql_text())) - BASE_COLUMNS
    py_columns = {name for name, _ in d5_cache_local.SCHEMA_COLUMNS}

    assert sql_columns == py_columns, (
        "docker/init.sql and d5_cache_local.SCHEMA_COLUMNS disagree.\n"
        f"  in init.sql only:       {sorted(sql_columns - py_columns)}\n"
        f"  in SCHEMA_COLUMNS only: {sorted(py_columns - sql_columns)}"
    )


def test_insert_columns_all_exist_in_schema():
    """
    The direct check on the original failure: every column save_to_cache()
    INSERTs into must be one the schema actually defines.
    """
    known = (
        set(_create_table_columns(_init_sql_text()))
        | {name for name, _ in d5_cache_local.SCHEMA_COLUMNS}
        | BASE_COLUMNS
    )
    unknown = [c for c in _insert_columns() if c not in known]

    assert not unknown, (
        f"save_to_cache() INSERTs column(s) no schema defines: {unknown}. "
        "Every cache write will fail with 'column ... does not exist' and "
        "/generate will silently degrade to a fallback clip on every request."
    )


@pytest.mark.parametrize("column", [
    "valence", "arousal", "intensity", "duration_seconds",
    "seam_discontinuity", "prompt_source", "generation_seed",
])
def test_columns_from_the_original_regression_are_present(column):
    """The seven columns the live dev volume was actually missing."""
    assert column in _create_table_columns(_init_sql_text())
    assert column in _alter_table_columns(_init_sql_text())
    assert column in {name for name, _ in d5_cache_local.SCHEMA_COLUMNS}
    assert column in _insert_columns()


def test_ensure_schema_runs_before_prewarm_on_dev_startup(call_log, monkeypatch):
    """
    The whole point of ensure_schema() is that nobody has to remember to run a
    migration -- so it has to actually be wired into startup, and it has to run
    BEFORE prewarm_cache, which writes through save_to_cache immediately.
    """
    import sys

    monkeypatch.setenv("IS_PROD", "false")
    for mod in ("main", "d3_generate", "d5_cache_local", "d5_cache"):
        sys.modules.pop(mod, None)

    import main as main_module

    order = []
    monkeypatch.setattr(main_module, "ensure_schema", lambda: order.append("ensure_schema"))

    async def fake_prewarm_cache(*args, **kwargs):
        order.append("prewarm")

    monkeypatch.setattr(main_module, "prewarm_cache", fake_prewarm_cache)

    from fastapi.testclient import TestClient

    with TestClient(main_module.app):
        pass

    assert "ensure_schema" in order, (
        "main.py's lifespan never called ensure_schema() -- a dev DB whose "
        "volume predates a column will silently fail every cache write again."
    )
    assert order.index("ensure_schema") < (order.index("prewarm") if "prewarm" in order else len(order)), (
        "ensure_schema() must complete before prewarm_cache starts writing rows"
    )


def test_startup_survives_an_unreachable_database(call_log, monkeypatch):
    """
    A dead DB must not stop the server from booting -- /generate still works
    without a cache (it just regenerates every time), and main.py's
    check_cache/save_to_cache handlers already assume that.
    """
    import sys

    monkeypatch.setenv("IS_PROD", "false")
    for mod in ("main", "d3_generate", "d5_cache_local", "d5_cache"):
        sys.modules.pop(mod, None)

    import main as main_module

    def boom():
        raise OSError("could not connect to server: Connection refused")

    monkeypatch.setattr(main_module, "ensure_schema", boom)

    async def fake_prewarm_cache(*args, **kwargs):
        return None

    monkeypatch.setattr(main_module, "prewarm_cache", fake_prewarm_cache)

    from fastapi.testclient import TestClient

    with TestClient(main_module.app) as client:
        # Any route will do -- the point is that startup completed at all.
        assert client.get("/fallback/calm").status_code in (200, 503)
