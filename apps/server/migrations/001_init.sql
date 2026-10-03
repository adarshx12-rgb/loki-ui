-- NodePilot initial schema

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  from_revision INTEGER,
  to_revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  touched_nodes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_log_wf ON audit_log(workflow_id, to_revision);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  title TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | applied | rejected | superseded
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_revision INTEGER NOT NULL,
  executable_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT,
  nodes_json TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX runs_wf ON runs(workflow_id, created_at);

CREATE TABLE run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  node_id TEXT,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  message TEXT,
  data_json TEXT,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE workflow_files (
  workflow_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  last_hash TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

-- ---- auth ----
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE auth_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  at TEXT NOT NULL
);

-- ---- Claude runner ----
CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  info_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE runner_pair_requests (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  poll_secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  info_json TEXT NOT NULL,
  status TEXT NOT NULL, -- pending | approved | denied | collected
  runner_id TEXT,
  issued_token TEXT, -- held only until the runner collects it once
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT,
  node_id TEXT,
  runner_id TEXT,
  parent_task_id TEXT,
  project_path TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  run_tests INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  status_detail TEXT,
  session_id TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_events (
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  data_json TEXT,
  PRIMARY KEY (task_id, seq)
);

-- ---- monitoring ----
CREATE TABLE services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ingest_token_hash TEXT NOT NULL UNIQUE,
  stale_after_s INTEGER NOT NULL DEFAULT 600,
  created_at TEXT NOT NULL,
  last_event_at TEXT,
  duplicate_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE health_targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  service_id TEXT,
  interval_s INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_ok INTEGER,
  last_status INTEGER,
  last_latency_ms INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE telemetry_events (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  ts TEXT NOT NULL,
  received_at TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (service_id, event_id)
);
CREATE INDEX telemetry_events_received ON telemetry_events(received_at);

CREATE TABLE external_runs (
  service_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_revision INTEGER,
  environment TEXT,
  code_revision TEXT,
  first_ts TEXT NOT NULL,
  last_ts TEXT NOT NULL,
  PRIMARY KEY (service_id, run_id)
);

CREATE TABLE external_node_states (
  service_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  rank INTEGER NOT NULL,
  ts TEXT NOT NULL,
  duration_ms REAL,
  error_json TEXT,
  output_json TEXT,
  eval_status TEXT,
  eval_ts TEXT,
  eval_json TEXT,
  PRIMARY KEY (service_id, run_id, node_id)
);

-- ---- GitHub ----
CREATE TABLE github_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  repo_full_name TEXT,
  associated INTEGER NOT NULL,
  summary TEXT NOT NULL,
  received_at TEXT NOT NULL
);
