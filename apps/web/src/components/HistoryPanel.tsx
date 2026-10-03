import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { dotFor, fmtAgo, fmtMs, StatusChip } from '../status';

type Source = 'run' | 'external' | 'task';
type Filter = 'all' | 'success' | 'failed' | 'running' | 'attention';

interface Entry {
  key: string;
  source: Source;
  status: string;
  title: string;
  subtitle: string;
  at: string;
  durationMs?: number;
  error?: string;
  selected: boolean;
  open: () => void;
}

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['success', 'Success'],
  ['failed', 'Failed'],
  ['running', 'Running'],
  ['attention', 'Attention'],
];

const SOURCES: [Source | 'all', string][] = [
  ['all', 'All sources'],
  ['external', 'Original project'],
  ['run', 'Local runs'],
  ['task', 'Claude tasks'],
];

function bucket(status: string): Filter {
  const d = dotFor(status, 0);
  return d === 'active' ? 'success' : d === 'stopped' ? 'failed' : d === 'running' ? 'running' : d === 'attention' ? 'attention' : 'all';
}

/** Everything that happened with this workflow: telemetry from the original project, local runs and Claude tasks. */
export function HistoryView() {
  const runs = useStore((s) => s.runs);
  const externalRuns = useStore((s) => s.externalRuns);
  const tasks = useStore((s) => s.tasks);
  const overlay = useStore((s) => s.overlay);
  const runDetail = useStore((s) => s.runDetail);
  const s = useStore.getState;
  const [filter, setFilter] = useState<Filter>('all');
  const [source, setSource] = useState<Source | 'all'>('all');
  const [q, setQ] = useState('');

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [
      ...externalRuns.map((r) => ({
        key: `x:${r.serviceId}:${r.runId}`,
        source: 'external' as const,
        status: r.status,
        title: r.serviceId,
        subtitle: `${r.runId}${r.environment ? ` · ${r.environment}` : ''}${r.codeRevision ? ` · ${r.codeRevision.slice(0, 8)}` : ''}`,
        at: r.lastTs,
        error: Object.values(r.nodes).find((n) => n.error)?.error?.message,
        selected: overlay?.kind === 'external' && overlay.runId === r.runId && overlay.serviceId === r.serviceId,
        open: () => s().viewExternal(r.serviceId, r.runId),
      })),
      ...runs.map((r) => ({
        key: `r:${r.id}`,
        source: 'run' as const,
        status: r.status,
        title: `Local run · r${r.workflowRevision}`,
        subtitle: r.id,
        at: r.createdAt,
        durationMs: r.durationMs,
        error: r.error,
        selected: overlay?.kind === 'local' && overlay.runId === r.id,
        open: () => void s().viewRun(r.id),
      })),
      ...tasks.map((t) => ({
        key: `t:${t.id}`,
        source: 'task' as const,
        status: t.status,
        title: t.title,
        subtitle: `Claude task · ${t.permissionMode}`,
        at: t.updatedAt,
        error: t.status === 'failed' ? t.statusDetail : undefined,
        selected: false,
        open: () => s().set({ openTaskId: t.id }),
      })),
    ];
    return list.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [runs, externalRuns, tasks, overlay, s]);

  const scoped = entries.filter((e) => source === 'all' || e.source === source);
  const counts = Object.fromEntries(FILTERS.map(([f]) => [f, f === 'all' ? scoped.length : scoped.filter((e) => bucket(e.status) === f).length])) as Record<Filter, number>;
  const term = q.trim().toLowerCase();
  const shown = scoped.filter((e) => (filter === 'all' || bucket(e.status) === filter) && (!term || `${e.title} ${e.subtitle} ${e.status} ${e.error ?? ''}`.toLowerCase().includes(term)));

  return (
    <div className="hist">
      {overlay && (
        <div className="hist-overlay">
          <span className="muted small">A run is shown on the canvas.</span>
          <button className="btn ghost xs" onClick={() => void s().viewRun(null)}>Clear overlay</button>
        </div>
      )}
      <div className="hist-filters" role="group" aria-label="Filter by outcome">
        {FILTERS.map(([f, label]) => (
          <button key={f} className={`hist-chip f-${f}${filter === f ? ' on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {label} <span className="hist-count">{counts[f]}</span>
          </button>
        ))}
      </div>
      <div className="hist-tools">
        <select className="input xs" value={source} onChange={(e) => setSource(e.target.value as Source | 'all')} aria-label="Source">
          {SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input className="input xs" type="search" placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search history" />
      </div>
      <ol className="hist-list">
        {shown.map((e) => (
          <li key={e.key}>
            <button className={`hist-item${e.selected ? ' sel' : ''}`} onClick={e.open} title={e.source === 'task' ? 'Open task' : 'Overlay this run on the canvas'}>
              <span className={`dot dot-${dotFor(e.status, 0)}`} aria-hidden="true" />
              <span className="hist-main">
                <span className="hist-title">{e.title}</span>
                <span className="hist-sub mono">{e.subtitle}</span>
                {e.error && <span className="hist-err">{e.error}</span>}
              </span>
              <span className="hist-meta">
                <StatusChip status={e.status} small />
                <span className="muted xs">{fmtAgo(e.at)}{e.durationMs ? ` · ${fmtMs(e.durationMs)}` : ''}</span>
              </span>
            </button>
            {e.selected && e.source === 'run' && runDetail && (
              <div className="hist-detail">
                {Object.values(runDetail.nodes).filter((n) => n.status === 'failed' || n.status === 'skipped').slice(0, 6).map((n) => (
                  <button key={n.nodeId} className="link small" onClick={() => s().select(n.nodeId)}>{n.status}: {n.nodeId}</button>
                ))}
                <button className="btn ghost xs" onClick={() => s().togglePanel('logs', true)}>Open event log</button>
              </div>
            )}
          </li>
        ))}
        {shown.length === 0 && (
          <li className="muted pad small">
            {entries.length === 0
              ? 'Nothing yet. Run the workflow, connect the original project’s telemetry (Connections → Backends), or ask Claude for a task.'
              : 'No entries match these filters.'}
          </li>
        )}
      </ol>
    </div>
  );
}
