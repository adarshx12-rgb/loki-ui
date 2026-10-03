# Connecting Claude Code over MCP

The NodePilot MCP server is a **stdio** server (`apps/mcp/dist/index.js`) built on the
official `@modelcontextprotocol/sdk`. Claude Code launches it; it talks to the running
NodePilot server over loopback HTTP with a local token. stdout carries only MCP protocol
messages; diagnostics go to stderr.

## 1. Prerequisites

```bash
npm run build
npm start                 # the NodePilot server must be running; it creates .data/mcp-token
```

## 2. Register the server with Claude Code

The app shows the exact command for your machine under **Connections → Claude Code MCP**.
It has this shape (user scope, so it is available in every project):

```bash
claude mcp add nodepilot --scope user \
  -e NODEPILOT_URL=http://127.0.0.1:4317 \
  -e NODEPILOT_DATA_DIR="/absolute/path/to/repo/.data" \
  -- node "/absolute/path/to/repo/apps/mcp/dist/index.js"
```

On Windows use the full paths, e.g. `-- "C:\Program Files\nodejs\node.exe" "D:\code\nodepilot\apps\mcp\dist\index.js"`.

Alternatively add it to a project's `.mcp.json` (Claude Code asks you to approve project servers):

```json
{
  "mcpServers": {
    "nodepilot": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/repo/apps/mcp/dist/index.js"],
      "env": { "NODEPILOT_URL": "http://127.0.0.1:4317", "NODEPILOT_DATA_DIR": "/absolute/path/to/repo/.data" }
    }
  }
}
```

Check it: `claude mcp list` (should show `nodepilot` connected), or `/mcp` inside Claude Code.

## 3. Tools

| Tool | Effect |
| --- | --- |
| `list_workflows` | id, name, revision, node count |
| `get_workflow` | full document + validation |
| `inspect_node` | node, connections, issues, recent run history |
| `validate_workflow` | save/run/warning issues |
| `propose_workflow_patch` | validates a patch and queues it for **human review** in the app (Workflow panel → Proposals) |
| `apply_workflow_patch` | applies immediately (audit actor `mcp`), shows live on the canvas |
| `add_node_note` | appends a Markdown note attributed to Claude Code (no base revision needed) |
| `inspect_run` | run status, per-node state (redacted/truncated), optional events |

Patches are lists of ops (`add_node`, `replace_node`, `update_node`, `remove_node`,
`move_node`, `set_node_display`, `append_node_note`, `add_edge`, `remove_edge`,
`update_workflow`) and need the `baseRevision` Claude read. A stale revision returns a
conflict that lists who changed what since, so Claude can re-read and retry. Structural
errors (cycles, incompatible ports, secrets in params…) are rejected with details.

Try: *"Use nodepilot: list workflows, inspect the scanner node of the example, and add a
note suggesting a timeout of 60 s."*

## Troubleshooting

- `server_unreachable`: start the NodePilot server, check `NODEPILOT_URL`.
- `Cannot read the NodePilot MCP token`: `NODEPILOT_DATA_DIR` must point to the server's data dir.
- `401`: the token file changed (e.g. data dir deleted); restart Claude Code so the MCP server re-reads it.
