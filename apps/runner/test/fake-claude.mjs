#!/usr/bin/env node
// TEST FIXTURE ONLY — a fake "claude" CLI that mimics the documented stream-json output
// shape so runner tests do not make paid model calls. It is never used outside tests.
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('9.9.9 (Fake Claude Code for tests)');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log(`Usage: claude [options] [command] [prompt]
Options:
  --add-dir <directories...>            Additional directories
  --allowedTools, --allowed-tools <tools...>
      Allowed tools
  --dangerously-skip-permissions        Bypass all permission checks.
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming) (choices: "text", "json",
                                        "stream-json")
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts
  -p, --print                           Print response and exit
  -r, --resume [value]                  Resume a conversation
  --session-id <uuid>                   Use a specific session ID
  --verbose                             Override verbose mode setting`);
  process.exit(0);
}
if (args.some((a) => /dangerously|bypassPermissions/.test(a))) {
  console.error('fake-claude: bypass flag received');
  process.exit(3);
}
const prompt = fs.readFileSync(0, 'utf8');
const sid = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : args.includes('--resume') ? args[args.indexOf('--resume') + 1] : crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
fs.writeFileSync('fake-args.json', JSON.stringify(args));
out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-model', permissionMode: args[args.indexOf('--permission-mode') + 1], tools: ['Edit'], cwd: process.cwd() });
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'I will add a note file.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'NOTE.md' } }] } });
if (prompt.includes('SLOW')) await new Promise((r) => setTimeout(r, 60_000));
fs.writeFileSync('NOTE.md', `# Fake change\n\nPrompt length: ${prompt.length}\n`);
out({ type: 'user', session_id: sid, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File written' }] } });
out({
  type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'Added NOTE.md', total_cost_usd: 0, num_turns: 2, duration_ms: 10,
  permission_denials: [{ tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'git push' } }],
});
