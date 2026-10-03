import { create } from 'zustand';
import {
  applyPatch,
  diffWorkflows,
  stableStringify,
  touchedNodeIds,
  type BusEvent,
  type PatchOp,
  type RunDetail,
  type RunEvent,
  type RunSummary,
  type ValidationResult,
  type Workflow,
} from '@nodepilot/shared';
import { api, ApiError, enc } from './api';

export interface WorkflowListItem { id: string; name: string; revision: number; isExample: boolean; nodeCount: number; updatedAt: string; projectId?: string }
export interface AuditEntry { id: number; fromRevision: number | null; toRevision: number; actor: string; summary: string; touchedNodes: string[]; createdAt: string }
export interface Proposal { id: string; baseRevision: number; actor: string; title: string; summary: string; status: string; createdAt: string; validation: ValidationResult }
export interface ExternalRun {
  serviceId: string; runId: string; workflowId: string; workflowRevision: number | null; environment: string | null; codeRevision: string | null;
  firstTs: string; lastTs: string; status: string;
  nodes: Record<string, { status: string; ts: string; durationMs?: number; error?: { message: string; type?: string }; output?: unknown; evaluation?: { status: string; ts: string; detail: unknown } }>;
}
export interface TaskSummary { id: string; title: string; status: string; statusDetail?: string; nodeId?: string; workflowId?: string; createdAt: string; updatedAt: string; permissionMode: string; projectPath: string; runnerId?: string; cancelRequested: boolean; sessionId?: string }
export interface Conflict { message: string; details?: { currentRevision?: number; changesSince?: AuditEntry[]; overlappingNodes?: string[] }; retry?: () => Promise<void> }
export interface Toast { id: number; kind: 'info' | 'error' | 'success'; text: string }

interface UndoEntry { label: string; before: Workflow; after: Workflow }

export type Tool = 'select' | 'marquee' | 'hand' | 'node';

type Overlay = { kind: 'local'; runId: string } | { kind: 'external'; serviceId: string; runId: string } | null;

interface State {
  paired: boolean | null;
  appName: string;
  live: 'connecting' | 'live' | 'offline';
  workflows: WorkflowListItem[];
  wf: Workflow | null;
  validation: ValidationResult | null;
  execHash: string;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  /** Nodes selected together (rectangle selection). Empty when 0 or 1 node is selected. */
  multiSelected: string[];
  /** Active canvas tool. Connections can only be created or removed with the node tool. */
  tool: Tool;
  setTool(t: Tool): void;
  runs: RunSummary[];
  overlay: Overlay;
  runDetail: RunDetail | null;
  runEvents: RunEvent[];
  externalRuns: ExternalRun[];
  audit: AuditEntry[];
  proposals: Proposal[];
  tasks: TaskSummary[];
  undo: UndoEntry[];
  redo: UndoEntry[];
  conflict: Conflict | null;
  toasts: Toast[];
  remoteFlash: { nodeIds: string[]; actor: string; at: number } | null;
  dialog: null | 'connections' | 'ask' | 'newWorkflow' | 'validate' | 'help' | 'import' | 'deleteWorkflow' | 'simReview';
  deleteTarget: { id: string; name: string; imported: boolean } | null;
  /**
   * Open simulation: edits and runs go to a hidden sandbox copy (`wf` is the sandbox).
   * `base` is the project as it was when the simulation started, advanced by every change applied to main.
   */
  sim: { mainId: string; mainName: string; sandboxId: string; base: Workflow; mainRevision: number } | null;
  startSimulation(): Promise<void>;
  /** Pushes some simulation changes into the real project. Returns an error message, or null on success. */
  applySimChanges(ops: PatchOp[], label: string): Promise<string | null>;
  /** Leaves the simulation, discarding the sandbox and anything not applied. */
  exitSimulation(): Promise<void>;
  /** Permanently deletes a project: its workflow, history, and the demo copy of its files if it was imported. */
  deleteWorkflow(id: string): Promise<boolean>;
  /** Floating panels; the canvas is the only thing shown by default. */
  panels: { inspector: boolean; logs: boolean };
  /** Tab shown by the inspector (the note icon on a node jumps to 'notes'). */
  inspectorTab: string;
  /** Open section of the right-hand dock; null = collapsed to its icon rail. */
  rightTab: string | null;
  toggleRight(tab: string): void;
  /** ComfyUI-style node search popup, at a screen position. */
  nodeSearch: { x: number; y: number } | null;
  togglePanel(p: keyof State['panels'], open?: boolean): void;
  connectionsTab: string;
  askTarget: { nodeId?: string } | null;
  openTaskId: string | null;
  bottomTab: string;

  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
  init(): Promise<void>;
  loadWorkflows(): Promise<void>;
  loadWorkflow(id: string): Promise<void>;
  refresh(): Promise<void>;
  select(nodeId: string | null, edgeId?: string | null): void;
  patch(ops: PatchOp[], label: string, opts?: { undoable?: boolean; baseRevision?: number }): Promise<boolean>;
  doUndo(): Promise<void>;
  doRedo(): Promise<void>;
  startRun(input?: unknown): Promise<void>;
  cancelRun(): Promise<void>;
  viewRun(runId: string | null): Promise<void>;
  viewExternal(serviceId: string, runId: string): void;
  loadSide(): Promise<void>;
  onBus(e: BusEvent): void;
  set(p: Partial<State>): void;
}

export const safeStorage = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); } catch { /* storage unavailable */ }
  },
};

/** The simulation baseline survives reloads in this browser. */
const simStorage = {
  save(sim: { sandboxId: string; base: Workflow }) { safeStorage.set(`np.sim.${sim.sandboxId}`, JSON.stringify(sim.base)); },
  base(sandboxId: string): Workflow | null {
    try { return JSON.parse(safeStorage.get(`np.sim.${sandboxId}`) ?? 'null') as Workflow | null; } catch { return null; }
  },
  clear(sandboxId: string) { try { localStorage.removeItem(`np.sim.${sandboxId}`); } catch { /* unavailable */ } },
};

let toastId = 1;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State>((set, get) => ({
  paired: null,
  appName: 'NodePilot',
  live: 'connecting',
  workflows: [],
  wf: null,
  validation: null,
  execHash: '',
  selectedNodeId: null,
  selectedEdgeId: null,
  multiSelected: [],
  tool: 'select',
  // A leftover rectangle selection would sit on top of edges and swallow clicks, so the hand and node tools clear it.
  setTool: (tool) => set(tool === 'hand' || tool === 'node' ? { tool, multiSelected: [] } : { tool }),
  runs: [],
  overlay: null,
  runDetail: null,
  runEvents: [],
  externalRuns: [],
  audit: [],
  proposals: [],
  tasks: [],
  undo: [],
  redo: [],
  conflict: null,
  toasts: [],
  remoteFlash: null,
  dialog: null,
  deleteTarget: null,
  sim: null,
  panels: { inspector: false, logs: false },
  inspectorTab: 'overview',
  rightTab: null,
  nodeSearch: null,
  connectionsTab: 'projects',
  askTarget: null,
  openTaskId: null,
  bottomTab: 'events',

  set: (p) => set(p),

  toggleRight(tab) {
    set({ rightTab: get().rightTab === tab ? null : tab });
  },

  togglePanel(p, open) {
    const panels = { ...get().panels, [p]: open ?? !get().panels[p] };
    set({ panels });
  },

  toast(kind, text) {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, kind, text }].slice(-5) });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  async init() {
    const s = await api.get<{ paired: boolean; appName: string }>('/api/auth/status');
    set({ paired: s.paired, appName: s.appName });
    document.title = s.appName;
    if (!s.paired) return;
    await get().loadWorkflows();
    const last = safeStorage.get('np.lastWorkflow');
    const list = get().workflows;
    const pick = list.find((w) => w.id === last) ?? list[0];
    if (pick) await get().loadWorkflow(pick.id);
  },

  async startSimulation() {
    const main = get().wf;
    if (!main || get().sim || main.simulationOf) return;
    try {
      const sandbox = await api.post<Workflow>(`/api/workflows/${enc(main.id)}/simulation`);
      const sim = { mainId: main.id, mainName: main.name, sandboxId: sandbox.id, base: main, mainRevision: main.revision };
      simStorage.save(sim);
      set({ sim });
      await get().loadWorkflow(sandbox.id);
    } catch (e) {
      get().toast('error', `Could not start the simulation: ${(e as Error).message}`);
    }
  },

  async applySimChanges(ops, label) {
    const sim = get().sim;
    if (!sim || !ops.length) return null;
    try {
      const current = await api.get<{ workflow: Workflow }>(`/api/workflows/${enc(sim.mainId)}`);
      const r = await api.post<{ workflow: Workflow }>(`/api/workflows/${enc(sim.mainId)}/patch`, { baseRevision: current.workflow.revision, ops });
      // The baseline moves forward by the same changes, so applied ones drop off the list.
      let base = sim.base;
      try { base = applyPatch(sim.base, ops); } catch { base = r.workflow; }
      const next = { ...sim, base, mainRevision: r.workflow.revision };
      simStorage.save(next);
      set({ sim: next });
      void label;
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  },

  async exitSimulation() {
    const sim = get().sim;
    if (!sim) return;
    try { await api.del(`/api/workflows/${enc(sim.sandboxId)}`); } catch { /* already gone */ }
    simStorage.clear(sim.sandboxId);
    set({ sim: null, dialog: null });
    await get().loadWorkflows();
    await get().loadWorkflow(sim.mainId);
  },

  async deleteWorkflow(id) {
    const name = get().workflows.find((w) => w.id === id)?.name ?? 'project';
    try {
      await api.del(`/api/workflows/${enc(id)}`);
    } catch (e) {
      get().toast('error', `Could not delete “${name}”: ${(e as Error).message}`);
      return false;
    }
    await get().loadWorkflows();
    if (get().wf?.id === id) {
      const next = get().workflows[0];
      if (next) await get().loadWorkflow(next.id);
      else set({ wf: null, validation: null, execHash: '', selectedNodeId: null, selectedEdgeId: null, multiSelected: [], runs: [], overlay: null, runDetail: null, runEvents: [], externalRuns: [], audit: [], proposals: [], tasks: [], undo: [], redo: [], conflict: null });
    }
    get().toast('success', `Deleted “${name}”.`);
    return true;
  },

  async loadWorkflows() {
    set({ workflows: await api.get<WorkflowListItem[]>('/api/workflows') });
  },

  async loadWorkflow(id) {
    const r = await api.get<{ workflow: Workflow; validation: ValidationResult; executableHash: string }>(`/api/workflows/${enc(id)}`);
    const changed = get().wf?.id !== id;
    set({
      wf: r.workflow,
      validation: r.validation,
      execHash: r.executableHash,
      ...(changed ? { selectedNodeId: null, selectedEdgeId: null, undo: [], redo: [], overlay: null, runDetail: null, runEvents: [], conflict: null } : {}),
    });
    if (!r.workflow.simulationOf) safeStorage.set('np.lastWorkflow', id);
    await get().loadSide();
    // A simulation left open (reload, closed tab) is picked up again.
    if (!r.workflow.simulationOf && !get().sim) {
      const open = await api.get<Workflow | null>(`/api/workflows/${enc(id)}/simulation`).catch(() => null);
      if (open) {
        const sim = { mainId: id, mainName: r.workflow.name, sandboxId: open.id, base: simStorage.base(open.id) ?? r.workflow, mainRevision: r.workflow.revision };
        set({ sim });
        get().toast('info', `Resumed the open simulation of “${r.workflow.name}”.`);
        await get().loadWorkflow(open.id);
        return;
      }
    }
    if (changed) {
      const latest = get().runs[0];
      if (latest) await get().viewRun(latest.id);
    }
  },

  async loadSide() {
    const wf = get().wf;
    if (!wf) return;
    const [runs, audit, proposals, externalRuns, tasks] = await Promise.all([
      api.get<RunSummary[]>(`/api/workflows/${enc(wf.id)}/runs`),
      api.get<AuditEntry[]>(`/api/workflows/${enc(wf.id)}/audit`),
      api.get<Proposal[]>(`/api/workflows/${enc(wf.id)}/proposals`),
      api.get<ExternalRun[]>(`/api/workflows/${enc(wf.id)}/external-runs`),
      api.get<TaskSummary[]>(`/api/tasks?workflowId=${enc(wf.id)}`),
    ]);
    set({ runs, audit, proposals, externalRuns, tasks });
  },

  async refresh() {
    const wf = get().wf;
    if (wf) await get().loadWorkflow(wf.id);
    await get().loadWorkflows();
  },

  select(nodeId, edgeId = null) {
    set({ selectedNodeId: nodeId, selectedEdgeId: edgeId, multiSelected: [] });
  },

  async patch(ops, label, opts = {}) {
    const wf = get().wf;
    if (!wf || ops.length === 0) return false;
    const before = wf;
    try {
      const r = await api.post<{ workflow: Workflow; validation: ValidationResult; executableHash: string }>(`/api/workflows/${enc(wf.id)}/patch`, {
        baseRevision: opts.baseRevision ?? wf.revision,
        ops,
      });
      set({ wf: r.workflow, validation: r.validation, execHash: r.executableHash, conflict: null });
      if (opts.undoable !== false) {
        // The undo entry describes only this edit (computed locally), never concurrent remote changes.
        let after = r.workflow;
        try { after = applyPatch(before, ops); } catch { /* fall back to server result */ }
        set({ undo: [...get().undo, { label, before, after }].slice(-100), redo: [] });
      }
      return true;
    } catch (e) {
      handlePatchError(e, () => get().patch(ops, label, { ...opts, baseRevision: undefined }).then(() => undefined));
      return false;
    }
  },

  async doUndo() {
    const entry = get().undo.at(-1);
    const wf = get().wf;
    if (!entry || !wf) return;
    const ops = inverseOps(entry, wf);
    if (typeof ops === 'string') {
      get().toast('error', ops);
      set({ undo: get().undo.slice(0, -1) });
      return;
    }
    const ok = await get().patch(ops, `Undo ${entry.label}`, { undoable: false });
    if (ok) set({ undo: get().undo.slice(0, -1), redo: [...get().redo, entry] });
  },

  async doRedo() {
    const entry = get().redo.at(-1);
    const wf = get().wf;
    if (!entry || !wf) return;
    // Re-apply the original change: diff before→after of the original edit, applied to current.
    const ops = diffWorkflows(entry.before, entry.after);
    let after: Workflow;
    try {
      after = applyPatch(wf, ops);
    } catch (e) {
      get().toast('error', `Can't redo "${entry.label}": ${(e as Error).message}`);
      set({ redo: get().redo.slice(0, -1) });
      return;
    }
    const ok = await get().patch(ops, `Redo ${entry.label}`, { undoable: false });
    if (ok) set({ redo: get().redo.slice(0, -1), undo: [...get().undo, { label: entry.label, before: wf, after }] });
  },

  async startRun(input) {
    const wf = get().wf;
    if (!wf) return;
    try {
      const run = await api.post<RunSummary>(`/api/workflows/${enc(wf.id)}/runs`, { input, expectedRevision: wf.revision });
      set({ runs: [run, ...get().runs.filter((r) => r.id !== run.id)], bottomTab: 'events' });
      await get().viewRun(run.id);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'not_runnable') {
        set({ dialog: 'validate' });
        get().toast('error', 'Fix the run-blocking issues first.');
      } else get().toast('error', err.message);
    }
  },

  async cancelRun() {
    const o = get().overlay;
    if (o?.kind !== 'local') return;
    try {
      await api.post(`/api/runs/${enc(o.runId)}/cancel`);
    } catch (e) {
      get().toast('error', (e as Error).message);
    }
  },

  async viewRun(runId) {
    if (!runId) return set({ overlay: null, runDetail: null, runEvents: [] });
    set({ overlay: { kind: 'local', runId } });
    const [detail, events] = await Promise.all([api.get<RunDetail>(`/api/runs/${enc(runId)}`), api.get<RunEvent[]>(`/api/runs/${enc(runId)}/events`)]);
    if (get().overlay?.kind === 'local' && (get().overlay as { runId: string }).runId === runId) set({ runDetail: detail, runEvents: events });
  },

  viewExternal(serviceId, runId) {
    set({ overlay: { kind: 'external', serviceId, runId }, runDetail: null, runEvents: [] });
  },

  onBus(e) {
    const s = get();
    const wf = s.wf;
    switch (e.type) {
      case 'workflow.updated':
        if (wf && e.workflowId === wf.id && e.revision > wf.revision) {
          const prev = wf;
          void get().loadWorkflow(wf.id).then(() => {
            const next = get().wf!;
            const changed = next.nodes.filter((n) => stableStringify(prev.nodes.find((p) => p.id === n.id)) !== stableStringify(n)).map((n) => n.id);
            if (e.actor !== 'ui') {
              set({ remoteFlash: { nodeIds: changed, actor: e.actor, at: Date.now() } });
              get().toast('info', `Updated by ${e.actor === 'mcp' ? 'Claude Code (MCP)' : e.actor}: ${e.summary.slice(0, 140)}`);
            }
          });
        }
        debounceList();
        break;
      case 'workflow.created':
      case 'workflow.deleted':
        debounceList();
        break;
      case 'workflow.conflict':
        if (wf && e.workflowId === wf.id) get().toast('error', `File sync (${e.source}): ${e.message}`);
        break;
      case 'proposal.created':
        if (wf && e.workflowId === wf.id) {
          void api.get<Proposal[]>(`/api/workflows/${enc(wf.id)}/proposals`).then((proposals) => set({ proposals }));
        }
        break;
      case 'run.updated':
        if (wf && e.run.workflowId === wf.id) {
          const runs = s.runs.some((r) => r.id === e.run.id) ? s.runs.map((r) => (r.id === e.run.id ? e.run : r)) : [e.run, ...s.runs];
          set({ runs });
          if (s.overlay?.kind === 'local' && s.overlay.runId === e.run.id) void get().viewRun(e.run.id);
        }
        break;
      case 'run.event':
        if (s.overlay?.kind === 'local' && s.overlay.runId === e.event.runId) {
          if (!s.runEvents.some((x) => x.seq === e.event.seq)) set({ runEvents: [...s.runEvents, e.event] });
          // Node state comes from the server (actual events only).
          if (e.event.nodeId) scheduleRunRefresh(e.event.runId);
        }
        break;
      case 'telemetry.updated':
        if (wf && e.workflowId === wf.id) void api.get<ExternalRun[]>(`/api/workflows/${enc(wf.id)}/external-runs`).then((externalRuns) => set({ externalRuns }));
        break;
      case 'task.updated':
        if (wf) void api.get<TaskSummary[]>(`/api/tasks?workflowId=${enc(wf.id)}`).then((tasks) => set({ tasks }));
        break;
      default:
        break;
    }
  },
}));

function debounceList() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void useStore.getState().loadWorkflows(), 300);
}

const runRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleRunRefresh(runId: string) {
  if (runRefreshTimers.has(runId)) return;
  runRefreshTimers.set(runId, setTimeout(async () => {
    runRefreshTimers.delete(runId);
    const s = useStore.getState();
    if (s.overlay?.kind !== 'local' || s.overlay.runId !== runId) return;
    const detail = await api.get<RunDetail>(`/api/runs/${enc(runId)}`);
    useStore.setState({ runDetail: detail });
  }, 120));
}

function handlePatchError(e: unknown, retry: () => Promise<void>) {
  const s = useStore.getState();
  const err = e as ApiError;
  if (err.code === 'revision_conflict') {
    s.set({ conflict: { message: err.message, details: err.details as Conflict['details'], retry } });
  } else if (err.code === 'validation_failed' || err.code === 'invalid_patch' || err.code === 'patch_failed') {
    s.toast('error', err.message);
  } else {
    s.toast('error', err.message ?? String(e));
  }
}

/** Ops that revert exactly one local change, refusing if the touched nodes changed since (e.g. via MCP). */
function inverseOps(entry: UndoEntry, current: Workflow): PatchOp[] | string {
  const ops = diffWorkflows(entry.after, entry.before);
  const touched = touchedNodeIds(diffWorkflows(entry.before, entry.after));
  for (const id of touched) {
    const a = entry.after.nodes.find((n) => n.id === id);
    const c = current.nodes.find((n) => n.id === id);
    const strip = (n: typeof a) => (n ? { ...n, position: undefined } : n);
    if (stableStringify(strip(a)) !== stableStringify(strip(c))) return `Can't undo "${entry.label}": node ${id} was changed afterwards (possibly by MCP or file sync).`;
  }
  try {
    applyPatch(current, ops);
  } catch (e) {
    return `Can't undo "${entry.label}": ${(e as Error).message}`;
  }
  return ops;
}
