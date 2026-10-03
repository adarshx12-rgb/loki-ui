import type { WorkflowNode } from '@nodepilot/shared';
import type { ExternalRun } from './store';
import { useStore } from './store';

export type Tone = 'ok' | 'fail' | 'run' | 'warn' | 'idle' | 'info' | 'ext';

/** Every status has a colour AND an icon AND a text label. */
export const STATUS: Record<string, { label: string; icon: string; tone: Tone }> = {
  pending: { label: 'Pending', icon: '•', tone: 'idle' },
  queued: { label: 'Queued', icon: '◷', tone: 'idle' },
  running: { label: 'Running', icon: '▶', tone: 'run' },
  retrying: { label: 'Retrying', icon: '↻', tone: 'warn' },
  succeeded: { label: 'Succeeded', icon: '✓', tone: 'ok' },
  failed: { label: 'Failed', icon: '✕', tone: 'fail' },
  skipped: { label: 'Skipped', icon: '⤼', tone: 'warn' },
  cancelled: { label: 'Cancelled', icon: '⊘', tone: 'idle' },
  observed: { label: 'Observed only', icon: '◉', tone: 'ext' },
  started: { label: 'Started', icon: '▶', tone: 'run' },
  unknown: { label: 'Unknown', icon: '?', tone: 'idle' },
  stale: { label: 'Stale', icon: '⧗', tone: 'warn' },
  ok: { label: 'OK', icon: '✓', tone: 'ok' },
  failing: { label: 'Failing', icon: '✕', tone: 'fail' },
  completed: { label: 'Completed', icon: '✓', tone: 'ok' },
  rejected: { label: 'Rejected', icon: '⊘', tone: 'idle' },
  draft: { label: 'Draft', icon: '✎', tone: 'idle' },
  claimed: { label: 'Claimed', icon: '◷', tone: 'run' },
  awaiting_local_confirmation: { label: 'Awaiting runner confirmation', icon: '⌨', tone: 'warn' },
  testing: { label: 'Testing', icon: '⚗', tone: 'run' },
};

export function StatusChip({ status, title, small }: { status: string; title?: string; small?: boolean }) {
  const s = STATUS[status] ?? { label: status, icon: '•', tone: 'idle' as Tone };
  return (
    <span className={`chip tone-${s.tone}${small ? ' chip-sm' : ''}`} title={title ?? s.label}>
      <span aria-hidden="true">{s.icon}</span> {s.label}
    </span>
  );
}

export const KIND_ICON: Record<string, string> = {
  input: '⇥', planner: '◇', combiner: '⊕', scanner: '⌕', worker: '⚙', judge: '⚖', aggregator: 'Σ', api_service: '☁', model: '✦', output: '⇤',
  instruction: '¶', auxiliary: '⋯', group: '▭', router: '◆', datastore: '⛁', module: '▢', ui: '▣',
};

export type Dot = 'active' | 'running' | 'attention' | 'stopped' | 'idle' | 'external';

/** Realtime dot on the bottom of every node. Colour + label so it is never colour-only. */
export const DOT: Record<Dot, { label: string; hint: string }> = {
  active: { label: 'Active', hint: 'Last run or telemetry succeeded' },
  running: { label: 'Running', hint: 'Executing right now' },
  attention: { label: 'Needs attention', hint: 'Retrying, skipped, stale, or has blocking issues' },
  stopped: { label: 'Stopped', hint: 'Failed, cancelled or suspended' },
  idle: { label: 'Idle', hint: 'No activity recorded yet' },
  external: { label: 'Observed', hint: 'Handled by the original project; waiting for its telemetry' },
};

export function dotFor(status: string | undefined, blockingIssues: number): Dot {
  switch (status) {
    case 'running': case 'started': case 'queued': case 'pending': case 'claimed': case 'testing': return 'running';
    case 'succeeded': case 'ok': case 'completed': return 'active';
    case 'failed': case 'failing': case 'cancelled': case 'rejected': return 'stopped';
    case 'retrying': case 'skipped': case 'stale': case 'awaiting_local_confirmation': return 'attention';
    case 'observed': return 'external';
  }
  return blockingIssues > 0 ? 'attention' : 'idle';
}

export function implBadge(n: WorkflowNode): { text: string; tone: Tone; title: string } {
  const i = n.config.implementation;
  switch (i.kind) {
    case 'demo': return { text: 'DEMO', tone: 'info', title: `Deterministic local demo handler "${i.handler}" — outputs are labelled demo data` };
    case 'model': return { text: `${i.provider}`, tone: 'ok', title: `Model adapter (${i.model})` };
    case 'observed': return { text: 'OBSERVED', tone: 'ext', title: `Implemented by external service "${i.serviceId}"; never executed here` };
    case 'script': return { text: 'SCRIPT DRAFT', tone: 'warn', title: 'Script stored as a draft. Execution unavailable until an isolated runner exists.' };
    case 'none': return { text: 'NOT CONFIGURED', tone: 'warn', title: 'No implementation' };
  }
}

/** Current status of a node from the selected overlay (actual events only). */
export function useNodeStatus(nodeId: string): { status: string; detail?: string; source: 'local' | 'external' } | null {
  const overlay = useStore((s) => s.overlay);
  const runDetail = useStore((s) => s.runDetail);
  const externalRuns = useStore((s) => s.externalRuns);
  return nodeStatus(nodeId, overlay, runDetail, externalRuns);
}

export function nodeStatus(
  nodeId: string,
  overlay: ReturnType<typeof useStore.getState>['overlay'],
  runDetail: ReturnType<typeof useStore.getState>['runDetail'],
  externalRuns: ExternalRun[],
): { status: string; detail?: string; source: 'local' | 'external' } | null {
  if (overlay?.kind === 'local' && runDetail && runDetail.id === overlay.runId) {
    const st = runDetail.nodes[nodeId];
    if (!st) return runDetail.status === 'running' || runDetail.status === 'queued' ? { status: 'pending', source: 'local' } : null;
    return { status: st.status, detail: st.error?.message ?? st.reason, source: 'local' };
  }
  if (overlay?.kind === 'external') {
    const run = externalRuns.find((r) => r.runId === overlay.runId && r.serviceId === overlay.serviceId);
    const st = run?.nodes[nodeId];
    if (!st) return null;
    return { status: st.status === 'unknown' ? 'unknown' : st.status, detail: st.error?.message, source: 'external' };
  }
  return null;
}

export function fmtTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function fmtAgo(iso?: string) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function fmtMs(ms?: number) {
  if (ms === undefined || ms === null) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
