import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { fmtAgo, fmtMs, fmtTime, StatusChip } from '../status';

const TABS = [
  ['events', 'Run events'],
  ['runs', 'Runs'],
  ['external', 'External telemetry'],
  ['activity', 'Activity'],
  ['tasks', 'Claude tasks'],
] as const;

export function Timeline({ onClose }: { onClose?: () => void }) {
  const tab = useStore((s) => s.bottomTab);
  const set = useStore((s) => s.set);
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className={`timeline${collapsed ? ' collapsed' : ''}`} aria-label="Run and event timeline">
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => { set({ bottomTab: k }); setCollapsed(false); }}>
            {label}
          </button>
        ))}
        <span className="grow" />
        <button className="btn ghost xs" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label="Toggle timeline">{collapsed ? '▴' : '▾'}</button>
        {onClose && <button className="btn ghost xs" onClick={onClose} aria-label="Close logs" title="Close (L)">✕</button>}
      </div>
      {!collapsed && (
        <div className="timeline-body" role="tabpanel">
          {tab === 'events' && <RunEvents />}
          {tab === 'runs' && <Runs />}
          {tab === 'external' && <External />}
          {tab === 'activity' && <Activity />}
          {tab === 'tasks' && <Tasks />}
        </div>
      )}
    </section>
  );
}

function RunEvents() {
  const overlay = useStore((s) => s.overlay);
  const events = useStore((s) => s.runEvents);
  const run = useStore((s) => s.runDetail);
  const wf = useStore((s) => s.wf);
  const select = useStore((s) => s.select);
  const [filter, setFilter] = useState('');
  // Prefer labels from the run's own snapshot (nodes may since have been renamed or removed).
  const snapshot = (run as unknown as { snapshot?: { nodes: { id: string; label: string }[] } } | null)?.snapshot;
  const label = (id?: string) => snapshot?.nodes.find((n) => n.id === id)?.label ?? wf?.nodes.find((n) => n.id === id)?.label ?? id;
  const list = useMemo(() => events.filter((e) => !filter || `${e.type} ${e.message ?? ''} ${label(e.nodeId)}`.toLowerCase().includes(filter.toLowerCase())), [events, filter]);
  if (overlay?.kind !== 'local') return <p className="muted pad">Select a local run in “Runs”, or press Run.</p>;
  return (
    <div>
      <div className="row pad-x">
        {run && <><StatusChip status={run.status} /> <span className="mono small">{run.id}</span> <span className="muted small">rev r{run.workflowRevision} · {fmtMs(run.durationMs)} · started by {run.actor}</span></>}
        {run?.error && <span className="tone-fail small">{run.error}</span>}
        <span className="grow" />
        <input className="input xs" placeholder="Filter events" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter events" />
      </div>
      <ol className="event-list">
        {list.map((e) => (
          <li key={e.seq} className={`ev ev-${e.type.split('.').pop()}`}>
            <span className="mono small muted">{fmtTime(e.at)}</span>
            <span className="mono ev-type">{e.type}</span>
            {e.nodeId && <button className="link" onClick={() => select(e.nodeId!)}>{label(e.nodeId)}</button>}
            <span className="ev-msg">{e.message}</span>
            {typeof (e.data as { durationMs?: number })?.durationMs === 'number' && <span className="mono small muted">{fmtMs((e.data as { durationMs: number }).durationMs)}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Runs() {
  const runs = useStore((s) => s.runs);
  const overlay = useStore((s) => s.overlay);
  const viewRun = useStore((s) => s.viewRun);
  if (!runs.length) return <p className="muted pad">No runs yet. Runs execute an immutable snapshot of the workflow on this machine.</p>;
  return (
    <table className="tbl">
      <thead><tr><th>Run</th><th>Status</th><th>Revision</th><th>Started</th><th>Duration</th><th>Error</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className={`clickable${overlay?.kind === 'local' && overlay.runId === r.id ? ' sel' : ''}`} onClick={() => void viewRun(r.id)}>
            <td className="mono small">{r.id}</td>
            <td><StatusChip status={r.status} small /></td>
            <td className="mono">r{r.workflowRevision} <span className="muted small" title="executable hash">{r.executableHash.slice(0, 8)}</span></td>
            <td>{fmtAgo(r.createdAt)}</td>
            <td className="mono">{fmtMs(r.durationMs)}</td>
            <td className="small tone-fail">{r.error}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function External() {
  const runs = useStore((s) => s.externalRuns);
  const overlay = useStore((s) => s.overlay);
  const view = useStore((s) => s.viewExternal);
  const set = useStore((s) => s.set);
  if (!runs.length) {
    return (
      <p className="muted pad">
        No telemetry from instrumented backends for this workflow. These are runs <b>observed</b> from your own services, never executed by NodePilot.{' '}
        <button className="link" onClick={() => set({ dialog: 'connections', connectionsTab: 'backends' })}>Set up a backend</button>
      </p>
    );
  }
  return (
    <table className="tbl">
      <thead><tr><th>Service</th><th>Run</th><th>Status</th><th>Env</th><th>Code rev</th><th>Workflow rev</th><th>Last event</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.serviceId + r.runId} className={`clickable${overlay?.kind === 'external' && overlay.runId === r.runId ? ' sel' : ''}`} onClick={() => view(r.serviceId, r.runId)} title="Overlay this external run on the canvas">
            <td>{r.serviceId}</td>
            <td className="mono small">{r.runId}</td>
            <td><StatusChip status={r.status} small /></td>
            <td>{r.environment ?? '—'}</td>
            <td className="mono small">{r.codeRevision?.slice(0, 10) ?? '—'}</td>
            <td className="mono">{r.workflowRevision ? `r${r.workflowRevision}` : '—'}</td>
            <td>{fmtAgo(r.lastTs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Activity() {
  const audit = useStore((s) => s.audit);
  return (
    <ol className="event-list">
      {audit.map((a) => (
        <li key={a.id} className="ev">
          <span className="mono small muted">{fmtAgo(a.createdAt)}</span>
          <span className="mono">r{a.toRevision}</span>
          <span className={`badge actor-${a.actor}`}>{a.actor === 'mcp' ? 'Claude Code (MCP)' : a.actor}</span>
          <span className="ev-msg">{a.summary}</span>
        </li>
      ))}
    </ol>
  );
}

function Tasks() {
  const tasks = useStore((s) => s.tasks);
  const set = useStore((s) => s.set);
  if (!tasks.length) return <p className="muted pad">No Claude tasks yet. Use “Ask Claude” on a node or the workflow.</p>;
  return (
    <table className="tbl">
      <thead><tr><th>Task</th><th>Status</th><th>Mode</th><th>Updated</th><th>Detail</th></tr></thead>
      <tbody>
        {tasks.map((t) => (
          <tr key={t.id} className="clickable" onClick={() => set({ openTaskId: t.id })}>
            <td>{t.title}</td>
            <td><StatusChip status={t.status} small /></td>
            <td className="mono small">{t.permissionMode}</td>
            <td>{fmtAgo(t.updatedAt)}</td>
            <td className="small">{t.statusDetail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
