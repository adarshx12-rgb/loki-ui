# Architecture

```
            browser (React + @xyflow/react)                 Claude Code
                 │  HTTP (cookie session) + SSE                  │ stdio (MCP)
                 ▼                                               ▼
 ┌──────────────────────────────────────────────┐      apps/mcp (MCP SDK)
 │ apps/server  (Fastify, 127.0.0.1:4317)       │◄──── HTTP + Bearer npm_… token
 │  ├─ WorkflowStore  ← single authority for    │
 │  │    validation, revisions, audit log       │◄──── apps/runner (paired, Bearer npr_…)
 │  ├─ RunManager + scheduler (local execution) │          └─ spawns `claude -p …` in a git worktree
 │  ├─ FileSync (chokidar)                      │
 │  ├─ Monitoring (health checks + telemetry)   │◄──── your backend + @nodepilot/instrument (Bearer npi_…)
 │  ├─ GitHub App adapter + webhook             │◄──── GitHub (needs a public URL / tunnel)
 │  ├─ Tasks (Claude task queue)                │
 │  └─ SQLite (node:sqlite, WAL) .data/         │
 └──────────────────────────────────────────────┘
```

One Node.js process holds all state. The MCP server and runner are separate small
processes because they are launched by different parties (Claude Code; the user), but
they never touch the database: every mutation goes through the server's HTTP API, so
UI, MCP, file sync and runner edits share **one** validation, revision and audit path,
and every change is broadcast to open canvases over SSE.

## Packages

| Path | Purpose |
| --- | --- |
| `packages/shared` | Zod schema (v1), graph algorithms, validation, patch ops + diff, post-processing, redaction, templates, seed example. `@nodepilot/shared/node` adds path restriction helpers. |
| `packages/instrument` | Zero-dependency telemetry reporter for your backends. |
| `apps/server` | HTTP API, SSE, persistence, execution, monitoring, GitHub, tasks. Migrations in `migrations/`. |
| `apps/mcp` | Stdio MCP server built with `@modelcontextprotocol/sdk` (`McpServer.registerTool`). |
| `apps/runner` | Local companion that pairs with the server and runs Claude Code tasks. |
| `apps/web` | Vite + React UI. |
| `examples/instrumented-backend` | Small HTTP service that implements the example pipeline and reports telemetry. |

## Workflow data model (schema v1)

`packages/shared/src/schema.ts`. A workflow has stable `id`, `revision`, `nodes`, `edges`.
Each node has:

- **visual**: `position`, `display` (colour, collapsed) — never affects execution;
- **contracts**: typed `inputs` (`required`, `multiple`, explicit `merge`: `array` or `object_by_source`) and `outputs`;
- **executable** `config`: `implementation` (`demo` | `model` | `observed` | `script` (draft only) | `none`), `params`, `timeoutMs`, `retry {maxAttempts, backoffMs, safeToRetry}`, `postProcess` steps, `demo` fault injection;
- **documentation**: Markdown `notes`, model `instructions`, repository-relative `codeRefs`.

Credentials are only ever **references** (`env:NAME`, `secret:name`). Params that look
like secrets are rejected at save time. `executableHash` covers everything that
affects execution and excludes layout, so moving a node never changes behaviour; each
run records the hash and an immutable snapshot of the workflow.

### Validation levels

- `save` — structural (schema, duplicate ids, dangling edges, missing ports, incompatible port types, fan-in to a single port, cycles, secrets in params). The change is rejected; nothing is persisted.
- `run` — blocks execution (missing required inputs, *Not configured*, script drafts, missing credentials).
- `warning` — informational (observed nodes, fault injection, retries requested without `safeToRetry`).

### Concurrency

Patches carry `baseRevision`. If it is stale, the server returns **409** with the
intervening audit entries, the nodes both sides touched and the latest document. The UI
offers *Reload latest* or *Re-apply my change on latest*; MCP gets the same text.
Layout-only ops (`move_node`, `set_node_display`) and `append_node_note` commute and are
rebased automatically. Undo/redo replays only your own edit and refuses if the touched
nodes changed since (e.g. via MCP).

## Execution

`apps/server/src/executor/scheduler.ts`: Kahn ordering, at most `NODEPILOT_CONCURRENCY`
nodes at a time; a node starts when all its upstream nodes are terminal. Required inputs
from failed/skipped/cancelled/observed producers mark the node `skipped` with the upstream
cause. Timeouts abort the handler's `AbortSignal`; cancellation aborts every running node
and marks the rest `cancelled`. Retries happen only for `safeToRetry` nodes and retryable
errors. Post-processing is a small validated language (select, map, filter, sort, limit) —
no user code runs. Inputs/outputs are redacted and truncated (16 KB) before storage.

Implementations:

- `demo` — deterministic local handlers; outputs carry a `_label` saying they are demo data.
- `model` — Anthropic Messages API adapter, used only when its credential reference resolves; token usage recorded only when the provider returns it.
- `observed` — implemented by an external backend; **never executed**, shown as *Observed only*.
- `script` — stored as a draft; execution is unavailable (no in-process VM is treated as a sandbox).
- `none` — *Not configured*.

If the server stops mid-run, the run is recorded as failed with an *Interrupted* message
on next start (it was executed by this app, so that is the honest outcome).

## Live updates

`/api/stream` is Server-Sent Events with a 1000-event ring buffer. Reconnecting clients
send `Last-Event-ID`; if the gap is no longer buffered (or the server restarted) the
server sends `resync` and the client refetches. Canvas status/edge highlighting is derived
only from recorded node states of the selected run (local or external) or from the
selected node's graph path; nothing is animated without a recorded event, and animation is
disabled under `prefers-reduced-motion`.

## Security model (local)

- **Loopback only** by default; binding elsewhere requires an explicit override.
- **Host allow-list** (DNS-rebinding defence) and **Origin allow-list** on every `/api` request; `Sec-Fetch-Site` cross-site requests without Origin are refused.
- **Browser pairing**: currently **off by default**. Without it, any request that passes the Host/Origin checks is treated as the local user — which means any program running under any account on this machine that can reach 127.0.0.1:4317 can use the API. Set `NODEPILOT_REQUIRE_PAIRING=1` to require a single-use code printed in the server terminal → HttpOnly, SameSite=Strict session cookie (failed attempts throttled). Runner pairing and MCP/ingest tokens are unaffected.
- **Scoped tokens**: MCP (`npm_…`, file in the data dir, workflow read/patch only), runner (`npr_…`, issued after you approve a pairing code in the browser), telemetry ingest (`npi_…`, per service, shown once, stored hashed).
- **Paths**: all file access goes through `resolveWithinRoots` (lexical check, then realpath check of the target or its nearest existing ancestor), so `..` traversal and symlink/junction escapes are refused.
- **Health checks**: only explicitly approved targets; http/https only; no credentials in URLs; cloud-metadata hosts and link-local/multicast/reserved addresses blocked at DNS-lookup time; redirects followed only within the approved origin; only status and latency are stored.
- **Secrets**: local write-only store in the data dir; known secret values plus common token formats are redacted from logs, run I/O, events, exports, task prompts and diffs. `.data/` and `.env` are git-ignored.
- **Limits**: 1 MB default body limit (256 KB telemetry, 4 MB runner results), bounded run/telemetry/delivery retention, bounded task event logs.
- **CSP** on the web app, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`. Markdown is rendered with `marked` and sanitised by DOMPurify.

## Limitations and future work

- Single user, single machine. No multi-tenant isolation, no TLS, no account system — not suitable for exposure beyond loopback.
- Only acyclic workflows. No loops, conditional branches or streaming between nodes.
- Model adapter covers the Anthropic Messages API only (non-streaming). Other providers need adapters.
- Custom scripts cannot run until a separately isolated runner (container/VM) exists.
- File sync imports a whole-document diff; it refuses files based on an older revision instead of merging.
- GitHub needs your own App; webhooks need a publicly reachable URL (tunnel). Polling via *Refresh* works without one.
- The runner runs Claude Code headless: anything that would need an interactive approval is **denied** and reported. Pre-approve narrow rules with `--allow-tool` if appropriate. It does not attach to an existing interactive terminal session.
- Worktrees start from `HEAD`; uncommitted changes in your checkout are untouched and not included. Worktrees are not deleted automatically (the task view shows the cleanup command). Tests run in the worktree, which has no `node_modules` unless your test command installs them.
- A VS Code extension is not included; code references use `vscode://file/…` links with a copy-path fallback. A future extension could highlight nodes for the open file and push edits over MCP.
- Production hardening still needed for anything beyond local use: TLS, real user auth, secret encryption at rest (OS keychain), backups, structured logging, rate limiting per client, and a proper job queue.
