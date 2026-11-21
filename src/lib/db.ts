import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.VOICEBOT_DB_PATH || path.join(dataDir, "voicebot.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
`);

export function ensureSession(id: string, mode: string) {
  db.prepare("INSERT OR IGNORE INTO sessions (id, mode) VALUES (?, ?)").run(id, mode);
}

export function addTurn(sessionId: string, role: "user" | "assistant", text: string, latencyMs?: number) {
  const info = db
    .prepare("INSERT INTO turns (session_id, role, text, latency_ms) VALUES (?, ?, ?, ?)")
    .run(sessionId, role, text, latencyMs ?? null);
  return info.lastInsertRowid;
}

export function getSession(id: string) {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | { id: string; mode: string; created_at: string }
    | undefined;
}

export function listSessions(limit = 20) {
  return db
    .prepare(
      `SELECT s.id, s.mode, s.created_at,
        (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turns,
        (SELECT text FROM turns t WHERE t.session_id = s.id ORDER BY id DESC LIMIT 1) AS last_text
       FROM sessions s ORDER BY s.created_at DESC LIMIT ?`
    )
    .all(limit);
}

export function getTurns(sessionId: string, limit = 200) {
  return db
    .prepare("SELECT role, text, latency_ms, created_at FROM turns WHERE session_id = ? ORDER BY id ASC LIMIT ?")
    .all(sessionId, limit);
}
