import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Local, file-backed state. Everything here is NateBot's own: which bots exist,
 * what they look like, and the run/step records the thread UI replays after a
 * reload. The conversation transcript itself stays owned by OpenClaw and is
 * read back through `chat.history` — we deliberately do not keep a second copy.
 */

export const NATEBOT_DIR = path.join(homedir(), ".natebot");
export const DB_PATH = path.join(NATEBOT_DIR, "natebot.db");
export const WORKSPACES_DIR = path.join(NATEBOT_DIR, "workspaces");

export type BotKind = "manager" | "worker";

export type Bot = {
  id: string;
  agentId: string;
  name: string;
  kind: BotKind;
  colorIndex: number;
  faceIndex: number;
  sessionKey: string;
  model: string | null;
  createdAt: number;
};

export type RunRow = {
  runId: string;
  botId: string;
  sessionKey: string;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "done" | "failed";
  stepCount: number;
};

export type StepRow = {
  runId: string;
  toolCallId: string;
  name: string;
  /** Parsed back into a value so replayed steps match live ones exactly. */
  args: unknown;
  result: string | null;
  isError: number;
  startedAt: number;
  endedAt: number | null;
};

function parseArgs(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

let db: DatabaseSync | null = null;

export function openDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(NATEBOT_DIR, { recursive: true });
  mkdirSync(WORKSPACES_DIR, { recursive: true });
  const handle = new DatabaseSync(DB_PATH);
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA foreign_keys = ON");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bots (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      color_index INTEGER NOT NULL,
      face_index  INTEGER NOT NULL,
      session_key TEXT NOT NULL,
      model       TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id      TEXT PRIMARY KEY,
      bot_id      TEXT NOT NULL,
      session_key TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      status      TEXT NOT NULL,
      step_count  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS runs_by_session ON runs (session_key, started_at);

    CREATE TABLE IF NOT EXISTS steps (
      run_id       TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      args         TEXT,
      result       TEXT,
      is_error     INTEGER NOT NULL DEFAULT 0,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      shot_path    TEXT,
      PRIMARY KEY (run_id, tool_call_id)
    );
  `);

  // Older databases predate the filmstrip; add the column in place rather than
  // forcing anyone to start over.
  const columns = handle.prepare("PRAGMA table_info(steps)").all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === "shot_path")) {
    handle.exec("ALTER TABLE steps ADD COLUMN shot_path TEXT");
  }
  db = handle;
  return handle;
}

/* ---------------------------------------------------------------- app state */

export function getState(key: string): string | null {
  const row = openDb().prepare("SELECT value FROM app_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string): void {
  openDb()
    .prepare(
      "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function getJsonState<T>(key: string, fallback: T): T {
  const raw = getState(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJsonState(key: string, value: unknown): void {
  setState(key, JSON.stringify(value));
}

/* -------------------------------------------------------------------- bots */

type BotDbRow = {
  id: string;
  agent_id: string;
  name: string;
  kind: string;
  color_index: number;
  face_index: number;
  session_key: string;
  model: string | null;
  created_at: number;
};

function toBot(row: BotDbRow): Bot {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    kind: row.kind === "manager" ? "manager" : "worker",
    colorIndex: row.color_index,
    faceIndex: row.face_index,
    sessionKey: row.session_key,
    model: row.model,
    createdAt: row.created_at,
  };
}

export function listBots(): Bot[] {
  const rows = openDb()
    .prepare("SELECT * FROM bots ORDER BY kind = 'manager' DESC, created_at ASC")
    .all() as unknown as BotDbRow[];
  return rows.map(toBot);
}

export function getBot(id: string): Bot | null {
  const row = openDb().prepare("SELECT * FROM bots WHERE id = ?").get(id) as
    | BotDbRow
    | undefined;
  return row ? toBot(row) : null;
}

export function getBotBySessionKey(sessionKey: string): Bot | null {
  const row = openDb().prepare("SELECT * FROM bots WHERE session_key = ?").get(sessionKey) as
    | BotDbRow
    | undefined;
  return row ? toBot(row) : null;
}

export function insertBot(bot: Bot): void {
  openDb()
    .prepare(
      `INSERT INTO bots (id, agent_id, name, kind, color_index, face_index, session_key, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      bot.id,
      bot.agentId,
      bot.name,
      bot.kind,
      bot.colorIndex,
      bot.faceIndex,
      bot.sessionKey,
      bot.model,
      bot.createdAt,
    );
}

export function updateBot(id: string, patch: Partial<Pick<Bot, "name" | "model" | "colorIndex" | "faceIndex">>): void {
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (patch.name !== undefined) (sets.push("name = ?"), values.push(patch.name));
  if (patch.model !== undefined) (sets.push("model = ?"), values.push(patch.model ?? ""));
  if (patch.colorIndex !== undefined) (sets.push("color_index = ?"), values.push(patch.colorIndex));
  if (patch.faceIndex !== undefined) (sets.push("face_index = ?"), values.push(patch.faceIndex));
  if (sets.length === 0) return;
  values.push(id);
  openDb().prepare(`UPDATE bots SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteBot(id: string): void {
  openDb().prepare("DELETE FROM bots WHERE id = ?").run(id);
}

/** Highest color/face index in use, so new bots keep extending the sequence. */
export function botCount(): number {
  const row = openDb().prepare("SELECT COUNT(*) AS n FROM bots WHERE kind = 'worker'").get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/* --------------------------------------------------------------- runs/steps */

export function upsertRunStart(run: { runId: string; botId: string; sessionKey: string; startedAt: number }): void {
  openDb()
    .prepare(
      `INSERT INTO runs (run_id, bot_id, session_key, started_at, status)
       VALUES (?, ?, ?, ?, 'running')
       ON CONFLICT(run_id) DO UPDATE SET started_at = excluded.started_at, status = 'running'`,
    )
    .run(run.runId, run.botId, run.sessionKey, run.startedAt);
}

export function finishRun(runId: string, endedAt: number, status: "done" | "failed"): void {
  openDb()
    .prepare("UPDATE runs SET ended_at = ?, status = ? WHERE run_id = ?")
    .run(endedAt, status, runId);
}

export function recordStepStart(step: {
  runId: string;
  toolCallId: string;
  name: string;
  args: unknown;
  startedAt: number;
}): void {
  const handle = openDb();
  handle
    .prepare(
      `INSERT INTO steps (run_id, tool_call_id, name, args, started_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, tool_call_id) DO UPDATE SET name = excluded.name, args = excluded.args`,
    )
    .run(step.runId, step.toolCallId, step.name, JSON.stringify(step.args ?? null), step.startedAt);
  handle
    .prepare(
      "UPDATE runs SET step_count = (SELECT COUNT(*) FROM steps WHERE run_id = ?) WHERE run_id = ?",
    )
    .run(step.runId, step.runId);
}

export function recordStepResult(step: {
  runId: string;
  toolCallId: string;
  result: string;
  isError: boolean;
  endedAt: number;
  shotPath: string | null;
}): void {
  openDb()
    .prepare(
      `UPDATE steps SET result = ?, is_error = ?, ended_at = ?, shot_path = ?
       WHERE run_id = ? AND tool_call_id = ?`,
    )
    .run(
      step.result.slice(0, 20_000),
      step.isError ? 1 : 0,
      step.endedAt,
      step.shotPath,
      step.runId,
      step.toolCallId,
    );
}

export function listRunsForSession(sessionKey: string): (RunRow & { steps: StepRow[] })[] {
  const handle = openDb();
  const runs = handle
    .prepare("SELECT * FROM runs WHERE session_key = ? ORDER BY started_at ASC")
    .all(sessionKey) as unknown as {
    run_id: string;
    bot_id: string;
    session_key: string;
    started_at: number;
    ended_at: number | null;
    status: string;
    step_count: number;
  }[];
  const stepStmt = handle.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY started_at ASC");
  return runs.map((r) => ({
    runId: r.run_id,
    botId: r.bot_id,
    sessionKey: r.session_key,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status as RunRow["status"],
    stepCount: r.step_count,
    steps: (stepStmt.all(r.run_id) as unknown as {
      run_id: string;
      tool_call_id: string;
      name: string;
      args: string | null;
      result: string | null;
      is_error: number;
      started_at: number;
      ended_at: number | null;
      shot_path: string | null;
    }[]).map((s) => ({
      runId: s.run_id,
      toolCallId: s.tool_call_id,
      name: s.name,
      args: s.args,
      result: s.result,
      isError: s.is_error,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      shotPath: s.shot_path,
    })),
  }));
}
