import { useStore } from '../store';
import { StatusChip } from '../status';
import { draftState } from '../inspector/draft';

export function Toolbar() {
  const s = useStore();
  const wf = s.wf;
  const run = s.overlay?.kind === 'local' ? s.runs.find((r) => r.id === (s.overlay as { runId: string }).runId) : undefined;
  const running = run && (run.status === 'running' || run.status === 'queued');
  const issues = s.validation?.issues ?? [];
  const blocking = issues.filter((i) => i.level !== 'warning').length;
  const dirty = draftState.useDirty();

  return (
    <header className="toolbar" role="toolbar" aria-label="Workflow actions">
      <div className="brand" title="Branding is configurable via NODEPILOT_APP_NAME">
        <span className="logo" aria-hidden="true">◈</span> {s.appName}
      </div>
      <select
        className="input wf-select"
        aria-label="Workflow"
        value={wf?.id ?? ''}
        onChange={(e) => void s.loadWorkflow(e.target.value)}
      >
        {s.workflows.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}{w.isExample ? ' (example)' : ''}
          </option>
        ))}
      </select>
      <button className="btn ghost" onClick={() => s.set({ dialog: 'newWorkflow' })} title="New workflow">＋ New</button>
      {wf && <span className="rev" title={`Revision ${wf.revision}. Executable hash ${s.execHash} (unchanged by layout edits)`}>r{wf.revision}</span>}
      <div className="sep" />
      <button className="btn" disabled={!dirty} onClick={() => draftState.save()} title="Save inspector changes (Ctrl+S)">
        {dirty ? '● Save' : 'Saved'}
      </button>
      <button className="btn ghost" disabled={!s.undo.length} onClick={() => void s.doUndo()} title={`Undo ${s.undo.at(-1)?.label ?? ''} (Ctrl+Z)`} aria-label="Undo">↶</button>
      <button className="btn ghost" disabled={!s.redo.length} onClick={() => void s.doRedo()} title={`Redo ${s.redo.at(-1)?.label ?? ''} (Ctrl+Shift+Z)`} aria-label="Redo">↷</button>
      <button className={`btn ${blocking ? 'warn' : 'ghost'}`} onClick={() => s.set({ dialog: 'validate' })} title="Validate workflow">
        {blocking ? `⚠ ${blocking} issue${blocking > 1 ? 's' : ''}` : '✓ Valid'}
      </button>
      <div className="sep" />
      <button className="btn primary" disabled={!wf || !!running} onClick={() => void s.startRun()} title="Run the workflow locally (Ctrl+Enter)">
        ▶ Run
      </button>
      <button className="btn danger" disabled={!running} onClick={() => void s.cancelRun()} title="Cancel the current run">■ Cancel</button>
      {run && <StatusChip status={run.status} />}
      <div className="grow" />
      <button className="btn ghost" disabled={!wf} onClick={() => s.set({ dialog: 'ask', askTarget: {} })} title="Ask Claude Code about this workflow">✦ Ask Claude</button>
      <button className="btn ghost" onClick={() => s.set({ dialog: 'connections' })} title="Projects, Claude runner, GitHub, backends, MCP">⚯ Connections</button>
      <button className="btn ghost" onClick={() => s.set({ dialog: 'help' })} title="Keyboard shortcuts (?)" aria-label="Help">?</button>
      <span className={`live live-${s.live}`} title={s.live === 'live' ? 'Live updates connected' : s.live === 'connecting' ? 'Connecting…' : 'Live updates disconnected — reconnecting'}>
        <span aria-hidden="true">●</span> {s.live === 'live' ? 'Live' : s.live === 'connecting' ? 'Connecting' : 'Offline'}
      </span>
    </header>
  );
}
