import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Per-profile SQLite database — CONTRACTS §4. state-engine owns migrations;
 * @tac/insights reads the same file read-only. DDL below is the binding
 * schema contract, verbatim.
 *
 * Driver: node:sqlite (DatabaseSync) — no native deps (CONTRACTS §2).
 */

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_state (
  task_id TEXT PRIMARY KEY, complete INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, ts TEXT);
CREATE TABLE IF NOT EXISTS objective_state (
  objective_id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0, ts TEXT);
CREATE TABLE IF NOT EXISTS hideout_state (station_id TEXT PRIMARY KEY, level INTEGER NOT NULL, ts TEXT);
CREATE TABLE IF NOT EXISTS trader_state (trader_id TEXT PRIMARY KEY, level INTEGER NOT NULL DEFAULT 1, rep REAL NOT NULL DEFAULT 0, ts TEXT);
CREATE TABLE IF NOT EXISTS raids (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, map TEXT, mode TEXT,
  queued_at TEXT, started_at TEXT, ended_at TEXT,
  queue_sec REAL, duration_sec REAL,
  outcome TEXT NOT NULL DEFAULT 'unknown',
  source TEXT NOT NULL DEFAULT 'live',
  version TEXT);
CREATE TABLE IF NOT EXISTS quest_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
  status TEXT NOT NULL, ts TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'live');
CREATE TABLE IF NOT EXISTS flea_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_name TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, raid_id INTEGER, map TEXT,
  x REAL, y REAL, z REAL, filename TEXT, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
  value REAL NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS perf_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT, raid_id INTEGER, map TEXT, ts TEXT NOT NULL,
  fps_avg REAL, fps_p1 REAL, frametime_p50 REAL, frametime_p95 REAL, frametime_p99 REAL,
  source TEXT NOT NULL DEFAULT 'presentmon');
-- M9 connectors provenance store; the environment↔outcome join key for M6.3 attribution.
CREATE TABLE IF NOT EXISTS connector_reading (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  game_version TEXT,
  settings_hash TEXT,
  raid_id INTEGER,
  data TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'connector');
CREATE INDEX IF NOT EXISTS idx_connector_reading_cap ON connector_reading(capability, captured_at);
CREATE INDEX IF NOT EXISTS idx_connector_reading_hash ON connector_reading(settings_hash);
-- M10 sources quota ledger; persists the shared external-API budget across restarts.
CREATE TABLE IF NOT EXISTS source_quota (
  source_id TEXT PRIMARY KEY,
  reads_remaining INTEGER,
  writes_remaining INTEGER,
  resets_at TEXT,
  updated_at TEXT NOT NULL);
`;

/**
 * Open (creating parent directories as needed) and migrate a profile database.
 * Pass ":memory:" for an in-memory database (tests).
 */
export function openDatabase(location: string): DatabaseSync {
  if (location !== ":memory:") mkdirSync(dirname(location), { recursive: true });
  const db = new DatabaseSync(location);
  if (location !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(DDL);
  return db;
}
