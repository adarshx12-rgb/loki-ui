# Verification results

Environment: Windows 11, Node.js 24.20.0, npm 11.19, git 2.55, Claude Code CLI 2.1.288,
Chrome (driven by `playwright-core`, no bundled browser). Date: 2026-10-03.

## Automated checks

| Command | Result |
| --- | --- |
| `npm run typecheck` | ✅ no errors (all packages + web) |
| `npm test` (Vitest) | ✅ 6 files, **53 tests passed**, no paid model calls |
| `npm run build` | ✅ all packages + Vite production bundle |

What the tests cover:

| Area | Tests (file) |
| --- | --- |
| Graph validation & cycles, incompatible/missing ports, fan-in, missing inputs/implementation/credentials, secrets in params, traversal in code refs | `packages/shared/src/shared.test.ts` |
| Patches: layout doesn't change executable hash, partial config updates, diff round-trip; post-processing; secret redaction (token formats, keyed secrets, known values, private keys in diffs) | `packages/shared/src/shared.test.ts` |
| Scheduler: dependency order, explicit merges, determinism, bounded parallelism, failure propagation, timeouts, safe-only retries, cancellation, observed/unconfigured nodes, post-processing | `apps/server/test/scheduler.test.ts` |
| Pairing (single use, throttling), Origin/Host restrictions, token scoping, payload limits | `apps/server/test/api.test.ts` |
| Concurrent revision conflicts (useful message, nothing overwritten), layout rebasing, invalid patches rejected, audit + live bus | `apps/server/test/api.test.ts` |
| Runs on immutable snapshots, not-runnable refusal, run cancellation | `apps/server/test/api.test.ts` |
| Path restrictions incl. `..`, absolute paths, null bytes, directory junction/symlink escape (existing and new files) | `apps/server/test/api.test.ts` |
| Telemetry duplicates, out-of-order events, staleness without changing outcomes, redaction, auth/validation | `apps/server/test/api.test.ts` |
| Webhook HMAC verification, dedupe, repo association; RS256 App JWT; disconnected state | `apps/server/test/api.test.ts` |
| Health-check guard: metadata hosts/IPs, schemes, credentials in URL, cross-origin redirects | `apps/server/test/api.test.ts` |
| File sync: own-write loop prevention, external import (actor `file`), stale-revision conflict, path escape | `apps/server/test/api.test.ts` |
| MCP: tool list, mutations through the store with live broadcast + audit, conflict and cycle rejection, notes, proposals, validate, inspect node/run, bad token | `apps/mcp/test/mcp.test.ts` |
| Runner: CLI capability detection, permission-mode mapping (never bypass), stream-json parsing, pairing with code check, project approval, worktree isolation (original uncommitted edit preserved), diff, tests, permission denials, cancellation | `apps/runner/test/runner.test.ts` (uses `fake-claude.mjs`, a clearly labelled test fixture) |
| Instrumentation helper: event sequence, sanitising, buffering/retry | `packages/instrument/src/instrument.test.ts` |

## Browser acceptance flow (`scripts/e2e-acceptance.mjs`)

Run against the production build served by `npm start`, in headless Chrome:

1. ✅ Pair the browser with the code from the server CLI.
2. ✅ Create a node from the palette; **Ctrl+Z / Ctrl+Shift+Z** undo and redo it.
3. ✅ Modify it through the **real stdio MCP server** (`apps/mcp/dist/index.js`, official SDK client): rename, set params and demo fault, connect two edges, add a note.
4. ✅ The open canvas updates **live** (no reload) and shows "Updated by Claude Code (MCP)".
5. ✅ Run the demo: the new node fails (injected fault), Score combiner is skipped with the upstream cause, independent judges succeed.
6. ✅ Inspect the failing node: *Errors & events* shows the error; *Notes* renders the MCP note as Markdown.
7. ✅ Start the runner process, approve its pairing code in **Connections → Claude runner**.
8. ✅ *Ask Claude* on the failing node → review the exact task text (contains `<untrusted_context>`) → approve in `acceptEdits` mode.
9. ✅ View progress, the **diff** and **test output** (`npm test` in the worktree).
10. ✅ Keyboard: fit view, help dialog. No browser console errors.

Runs:

- With the **fake Claude CLI fixture** (default): all steps pass.
- With the **real Claude Code CLI 2.1.288** (`E2E_CLAUDE_BIN=claude`): all steps pass. Claude
  created `NODEPILOT_CHECK.md` in the worktree; the runner parsed the real stream-json
  output (init, tool_use, tool_result, assistant, result), reported 1 changed file and
  passing tests. The CLI reported a cost of $0.13 for this single task.

## Monitoring check (`scripts/e2e-monitoring.mjs`)

With reduced motion enabled in the browser:

- ✅ Created a backend service in the UI; ingest token shown once.
- ✅ Approved `http://127.0.0.1:4400/health`; a `169.254.169.254` target was refused.
- ✅ Started the example backend with the token; one successful and one failing external run.
- ✅ Indicators: *Service reachable* OK, *Workflow executing* Failing (latest run failed), *Functional evaluation* OK (from the passing run's evaluation event), *Telemetry freshness* OK.
- ✅ External run overlaid on the canvas (nodes badged `EXT`); 0 animated edges under reduced motion.

## Other manual checks

- ✅ MCP stdout contains only JSON-RPC; diagnostics go to stderr.
- ✅ `scripts/github-webhook-test.mjs`: valid signature → 202, same delivery → duplicate ignored, tampered → 401.
- ✅ CSP / `X-Frame-Options` headers on the web app.

## Mocked or untested live integrations

| Integration | Status |
| --- | --- |
| GitHub REST API (installation token, commits, PRs, checks, Actions) | **Not tested live**: no GitHub App credentials were available. JWT signing and webhook handling are unit-tested; the API calls follow the documented endpoints. |
| GitHub webhook delivery from github.com | **Not tested**: needs a public URL/tunnel. Tested locally with signed requests. |
| Anthropic Messages API model adapter | **Not tested live**: no API key configured. Without a credential, model nodes show *Not configured*. |
| `claude mcp add` registration inside Claude Code | **Not executed** (it would change your Claude Code configuration). The same stdio server was exercised with the official MCP SDK client. |
| Runner on macOS/Linux | Not run here (process-group kill and shell differences are handled in code but untested). |
| Fake Claude CLI | Used only in automated tests and the default e2e run; labelled as a fixture in its source and in e2e output. |
