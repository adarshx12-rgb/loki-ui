# Claude runner: pairing and safety

The runner (`apps/runner`) lets the website hand a **reviewed** coding task to Claude Code
on your machine. It uses the documented headless interface,
`claude -p --output-format stream-json`, and never tries to inject text into an
existing interactive terminal. Each task is a separately identified Claude session
(`--session-id <uuid>`); continuing a previous task is explicit (`--resume`, only when the
installed CLI advertises it).

## Start and pair

1. Install Claude Code from the official docs and run `claude` once to sign in. The runner
   relies on Claude Code's own local authentication; it never reads or forwards your credentials.
2. Build and start NodePilot (`npm run build && npm start`).
3. Start the runner **yourself**, approving one or more git repositories:

   ```bash
   npm run runner -- --project "D:\code\my-ai-app" --test-cmd "npm test"
   ```

4. The runner prints a 6-digit **pairing code**. In the app open **Connections → Claude runner**,
   check the code matches, type it and **Approve**. The runner stores its token in
   `~/.nodepilot-runner/` (override with `--home`).

On start the runner inspects the installed CLI (`claude --version`, `claude --help`) and
checks for `--print`, `--output-format stream-json`, `--permission-mode` (and its
choices), `--permission-prompts`, `--session-id` and `--resume`. Missing capabilities are
reported to the app; if the CLI is absent, tasks fail with installation guidance instead
of pretending to run.

## What happens for a task

1. In the app: **Ask Claude** on a node/workflow → NodePilot composes a task description.
   Your instruction is kept separate from gathered context (config, contracts, code refs,
   notes, selected errors), which is wrapped in `<untrusted_context>` and explicitly framed as
   data. You can edit the exact text, then choose runner, project, permission mode and tests.
2. The runner receives it (long-poll) and **prints the full task** in its terminal. With the
   default `--confirm terminal` it asks `y/N` before doing anything; `--confirm browser`
   trusts the approval you gave in the app.
3. It verifies the project is inside its approved directories (realpath, symlink-safe),
   creates a **new git worktree on branch `nodepilot/<task>`** from `HEAD`, and runs:

   ```
   claude -p --output-format stream-json --verbose --permission-mode <mode> \
          --permission-prompts none --session-id <uuid> [--allowedTools <your --allow-tool rules>]
   ```

   The prompt is passed on stdin. **No bypass flags are ever passed** (the runner refuses
   them). Because the session is headless, anything that would need an interactive
   approval is denied, and those denials are reported in the app.
4. Progress (assistant text, tool calls, tool results, permission denials, result) streams
   to the app. **Cancel** kills the Claude process tree.
5. Afterwards the runner collects `git diff` against the base commit (including new files),
   runs your `--test-cmd` in the worktree if requested, redacts secrets, and reports
   everything. **It does not merge, push, deploy or copy changes back** to your checkout.

Permission modes offered: `plan`, `default` (mapped to the CLI's `manual` where needed),
`acceptEdits`, `dontAsk`. The website can only toggle tests; it can never supply its own command.

## Reviewing and cleaning up

The task view shows the diff, test output and the worktree path. To keep changes, review
the branch and merge it yourself. To discard:

```bash
git -C <repo> worktree remove <worktree path>
git -C <repo> branch -D nodepilot/<task>
```

Uncommitted changes in your original checkout are never touched (and are not included in
the worktree; the task notes when they exist).

## Disconnects

If the server is unreachable the runner keeps working, buffers events, and retries status
reports with backoff. The app shows a runner as disconnected after 45 s without contact.
Cancelling a task whose runner is disconnected marks it cancelled in the app and tells the
runner to stop when it reconnects; check the runner terminal for what actually happened.

## Options

```
--server <url>        default http://127.0.0.1:4317
--project <dir>       repeatable, required
--test-cmd <cmd>      optional
--test-timeout <sec>  default 600
--confirm terminal|browser
--allow-tool <rule>   repeatable, e.g. "Bash(npm test)"
--claude-bin <path>   default "claude"
--name, --home
```
