export const CURRENT_SCHEMA_VERSION = 1

export const SESSION_STATUSES = [
  "idle",
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const

export const MESSAGE_ROLES = ["system", "user", "assistant", "tool", "synthetic"] as const

export const createSchemaSql = `
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  team_id TEXT,
  metadata_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS workspace_roots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  label TEXT,
  readonly INTEGER NOT NULL,
  root_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, path)
);

CREATE INDEX IF NOT EXISTS idx_workspace_roots_session_id ON workspace_roots(session_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  model_id TEXT,
  usage_json TEXT,
  error_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at, id);

CREATE TABLE IF NOT EXISTS message_parts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  UNIQUE(message_id, part_index)
);

CREATE INDEX IF NOT EXISTS idx_message_parts_message_id ON message_parts(message_id, part_index);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  result_json TEXT,
  error_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message_id ON tool_calls(message_id);

CREATE TABLE IF NOT EXISTS runtime_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_session_time ON runtime_events(session_id, timestamp, id);

CREATE TABLE IF NOT EXISTS mcp_snapshots (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_snapshots_server_time ON mcp_snapshots(server_id, created_at DESC);
`
