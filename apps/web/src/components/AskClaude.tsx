import { useEffect, useMemo, useState } from 'react';
import { PERMISSION_MODES, type TaskEvent } from '@nodepilot/shared';
import { api, enc } from '../api';
import { useStore } from '../store';
import { fmtTime, StatusChip } from '../status';
import { Modal } from './Modal';

interface RunnerRow { id: string; name: string; online: boolean; info: { projects: string[]; claude: { found: boolean; version?: string; error?: string; supportsResume?: boolean }; testCommand?: string; confirmMode: string } }

const MODE_HELP: Record<string, string> = {
  plan: 'Plan only: Claude analyses and proposes, no edits.',
  default: 'Normal rules: anything needing approval is denied in headless mode (and reported).',
  acceptEdits: 'File edits inside the worktree are auto-accepted; commands still need approval (denied headless unless pre-approved on the runner).',
  dontAsk: 'Only tools pre-approved by your Claude settings / runner --allow-tool run; everything else is denied.',
};

export function AskClaude() {
  const s = useStore();
  const wf = s.wf!;
  const nodeId = s.askTarget?.nodeId;
  const node = wf.nodes.find((n) => n.id === nodeId);
  const failedRun = s.overlay?.kind === 'local' && s.runDetail && Object.values(s.runDetail.nodes).some((n) => n.status === 'failed') ? s.runDetail.id : undefined;
  const [instruction, setInstruction] = useState(
    node ? (s.runDetail?.nodes[node.id]?.status === 'failed' ? `Investigate why "${node.label}" failed in the last run and fix the underlying code.` : `Review the implementation of "${node.label}" and suggest improvements.`) : `Review the implementation of the "${wf.name}" workflow.`,
  );
  const [includeRun, setIncludeRun] = useState(!!failedRun);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [runners, setRunners] = useState<RunnerRow[]>([]);
  const [runnerId, setRunnerId] = useState('');
  const [project, setProject] = useState('');
  const [mode, setMode] = useState<(typeof PERMISSION_MODES)[number]>('acceptEdits');
  const [runTests, setRunTests] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<RunnerRow[]>('/api/runners').then((r) => {
      setRunners(r);
      const first = r.find((x) => x.online) ?? r[0];
      if (first) { setRunnerId(first.id); setProject(first.info.projects[0] ?? ''); }
    });
  }, []);
  const runner = runners.find((r) => r.id === runnerId);

  const compose = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ title: string; prompt: string }>('/api/tasks/compose', { workflowId: wf.id, nodeId, instruction, includeRunId: includeRun ? failedRun : undefined });
      setPrompt(r.prompt);
      setTitle(r.title);
    } catch (e) {
      s.toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!prompt) return;
    setBusy(true);
    try {
      const t = await api.post<{ id: string }>('/api/tasks', { runnerId, projectPath: project, title, prompt, permissionMode: mode, runTests: runTests && !!runner?.info.testCommand, workflowId: wf.id, nodeId });
      s.set({ dialog: null, openTaskId: t.id, bottomTab: 'tasks' });
    } catch (e) {
      s.toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={node ? `Ask Claude about “${node.label}”` : 'Ask Claude about this workflow'} onClose={() => s.set({ dialog: null })} wide>
      {!prompt ? (
        <div className="form">
          <label className="field">
            <span className="field-label">What should Claude do?</span>
            <textarea className="input" rows={4} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          </label>
          {failedRun && (
            <label className="row"><input type="checkbox" checked={includeRun} onChange={(e) => setIncludeRun(e.target.checked)} /> Include errors from the selected run ({failedRun})</label>
          )}
          <p className="muted small">NodePilot will add the node configuration, contracts, code references, notes and selected errors as clearly-marked <b>untrusted context</b>. You will review the exact text before anything is sent.</p>
          <div className="row"><span className="grow" /><button className="btn primary" disabled={busy || !instruction.trim()} onClick={() => void compose()}>Prepare task for review →</button></div>
        </div>
      ) : (
        <div className="form">
          <label className="field"><span className="field-label">Title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="field">
            <span className="field-label">Exact task text sent to Claude Code (editable)</span>
            <textarea className="input mono" rows={14} value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false} />
          </label>
          {runners.length === 0 ? (
            <div className="banner warn">No runner is paired. Start one and approve it under <button className="link" onClick={() => s.set({ dialog: 'connections', connectionsTab: 'runner' })}>Connections → Claude runner</button>.</div>
          ) : (
            <div className="grid2">
              <label className="field"><span className="field-label">Runner</span>
                <select className="input" value={runnerId} onChange={(e) => { setRunnerId(e.target.value); setProject(runners.find((r) => r.id === e.target.value)?.info.projects[0] ?? ''); }}>
                  {runners.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.online ? 'connected' : 'disconnected'}</option>)}
                </select>
              </label>
              <label className="field"><span className="field-label">Project (approved by the runner)</span>
                <select className="input mono" value={project} onChange={(e) => setProject(e.target.value)}>
                  {runner?.info.projects.map((p) => <option key={p}>{p}</option>)}
                </select>
              </label>
              <label className="field"><span className="field-label">Permission mode</span>
                <select className="input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                  {PERMISSION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <span className="field-help">{MODE_HELP[mode]} Bypass modes are never offered.</span>
              </label>
              <label className="field"><span className="field-label">Tests</span>
                <label className="row"><input type="checkbox" checked={runTests} disabled={!runner?.info.testCommand} onChange={(e) => setRunTests(e.target.checked)} /> Run <span className="mono">{runner?.info.testCommand ?? '(runner has no --test-cmd)'}</span> after Claude finishes</label>
              </label>
            </div>
          )}
          {runner && !runner.info.claude.found && <div className="banner fail">The runner reports Claude Code is not available: {runner.info.claude.error}</div>}
          {runner && !runner.online && <div className="banner warn">This runner is disconnected. The task will wait until it reconnects.</div>}
          <p className="muted small">Claude works in a new git worktree on a new branch. Your checkout (including uncommitted changes) is not touched, and nothing is merged or pushed. {runner?.info.confirmMode === 'terminal' ? 'The runner will also show this task in its terminal and ask you to confirm.' : ''}</p>
          <div className="row">
            <button className="btn ghost" onClick={() => setPrompt(null)}>← Back</button>
            <span className="grow" />
            <button className="btn primary" disabled={busy || !runner || !project || !runner.info.claude.found} onClick={() => void submit()}>Approve & send to runner</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

interface TaskFull {
  id: string; title: string; status: string; statusDetail?: string; prompt: string; permissionMode: string; projectPath: string; sessionId?: string; cancelRequested: boolean; runTests: boolean; createdAt: string;
  result?: { diff?: string; diffStat?: string; changedFiles?: string[]; diffTruncated?: boolean; worktreePath?: string; branch?: string; baseCommit?: string; cleanup?: string; note?: string; tests?: { command: string; exitCode: number | null; timedOut: boolean } | null; testOutput?: string; originalHadUncommittedChanges?: boolean; claude?: { isError: boolean; subtype?: string; resultText?: string; costUsd?: number; numTurns?: number; permissionDenials?: { tool_name?: string; tool_input?: unknown }[] } };
}

export function TaskDetail() {
  const id = useStore((s) => s.openTaskId)!;
  const set = useStore((s) => s.set);
  const tasks = useStore((s) => s.tasks);
  const [task, setTask] = useState<TaskFull | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [tab, setTab] = useState<'progress' | 'diff' | 'tests' | 'prompt'>('progress');
  const summaryStatus = tasks.find((t) => t.id === id)?.status;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [t, ev] = await Promise.all([api.get<TaskFull>(`/api/tasks/${enc(id)}`), api.get<TaskEvent[]>(`/api/tasks/${enc(id)}/events`)]);
      if (alive) { setTask(t); setEvents(ev); }
    };
    void load();
    const timer = setInterval(load, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [id, summaryStatus]);

  const diffLines = useMemo(() => (task?.result?.diff ?? '').split('\n'), [task?.result?.diff]);
  if (!task) return null;
  const r = task.result;
  const active = !['completed', 'failed', 'cancelled', 'rejected'].includes(task.status);
  return (
    <Modal title={task.title} onClose={() => set({ openTaskId: null })} wide>
      <div className="row">
        <StatusChip status={task.status} /> <span className="small">{task.statusDetail}</span>
        <span className="grow" />
        {active && <button className="btn danger small" disabled={task.cancelRequested} onClick={() => void api.post(`/api/tasks/${enc(task.id)}/cancel`).catch((e) => useStore.getState().toast('error', e.message))}>{task.cancelRequested ? 'Cancelling…' : 'Cancel task'}</button>}
      </div>
      <div className="kv small">
        <span>Task</span><span className="mono">{task.id}</span>
        <span>Project</span><span className="mono">{task.projectPath}</span>
        <span>Mode</span><span className="mono">{task.permissionMode}</span>
        {task.sessionId && <><span>Claude session</span><span className="mono">{task.sessionId}</span></>}
        {r?.branch && <><span>Worktree</span><span className="mono">{r.worktreePath} ({r.branch}, base {r.baseCommit?.slice(0, 10)})</span></>}
        {r?.claude?.costUsd !== undefined && <><span>Reported cost</span><span className="mono">${r.claude.costUsd.toFixed(4)} · {r.claude.numTurns} turns</span></>}
      </div>
      {r?.claude?.permissionDenials && r.claude.permissionDenials.length > 0 && (
        <div className="banner warn">⚠ {r.claude.permissionDenials.length} permission request(s) were denied (headless mode never auto-approves): {r.claude.permissionDenials.map((d) => d.tool_name).join(', ')}. Pre-approve specific rules with <span className="mono">--allow-tool</span> on the runner if appropriate.</div>
      )}
      {r?.note && <div className="banner info">{r.note}{r.cleanup && <> Cleanup when done:<pre className="code small">{r.cleanup}</pre></>}</div>}
      <div className="tabs" role="tablist">
        {(['progress', 'diff', 'tests', 'prompt'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
            {k === 'progress' ? 'Progress' : k === 'diff' ? `Diff${r?.changedFiles ? ` (${r.changedFiles.length})` : ''}` : k === 'tests' ? 'Tests' : 'Task text'}
          </button>
        ))}
      </div>
      {tab === 'progress' && (
        <ol className="event-list tall">
          {events.map((e) => (
            <li key={e.seq} className={`ev ev-${e.kind}`}>
              <span className="mono small muted">{fmtTime(e.at)}</span>
              <span className={`badge kind-${e.kind}`}>{e.kind}</span>
              <span className="ev-msg pre-wrap">{e.text}</span>
            </li>
          ))}
          {!events.length && <li className="muted">Waiting for the runner…</li>}
        </ol>
      )}
      {tab === 'diff' && (
        r?.diff ? (
          <div>
            <pre className="code small">{r.diffStat}</pre>
            {r.diffTruncated && <div className="banner warn">Diff truncated; inspect the worktree for the full change.</div>}
            <pre className="diff">{diffLines.map((l, i) => <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : l.startsWith('diff ') ? 'file' : ''}>{l || ' '}</div>)}</pre>
            <p className="muted small">Secrets are redacted from diffs shown here. Changes live only in the worktree branch; review and merge them yourself.</p>
          </div>
        ) : <p className="muted">{active ? 'The diff appears when Claude finishes.' : 'No changes.'}</p>
      )}
      {tab === 'tests' && (
        r?.tests ? (
          <div>
            <div className="row"><StatusChip status={r.tests.timedOut ? 'failed' : r.tests.exitCode === 0 ? 'succeeded' : 'failed'} /> <span className="mono">{r.tests.command}</span> <span className="small">{r.tests.timedOut ? 'timed out' : `exit code ${r.tests.exitCode}`}</span></div>
            <pre className="code small tall">{r.testOutput}</pre>
          </div>
        ) : <p className="muted">{task.runTests ? (active ? 'Tests run after Claude finishes.' : 'Tests did not run (Claude failed or was cancelled).') : 'Tests were not requested for this task.'}</p>
      )}
      {tab === 'prompt' && <pre className="code small tall pre-wrap">{task.prompt}</pre>}
    </Modal>
  );
}
