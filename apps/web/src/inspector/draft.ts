import { create } from 'zustand';
import { stableStringify, type WorkflowNode } from '@nodepilot/shared';
import { useStore } from '../store';

/**
 * Buffered inspector edits for one node. Saved explicitly (Save / Ctrl+S) as a
 * single update_node patch against the revision the edit started from, so a
 * concurrent change (MCP, file sync, another tab) produces a conflict instead of
 * being silently overwritten.
 */
type Changes = Partial<Pick<WorkflowNode, 'kind' | 'label' | 'purpose' | 'inputs' | 'outputs' | 'config' | 'notes' | 'instructions' | 'codeRefs'>>;

interface DraftState {
  nodeId: string | null;
  baseRevision: number;
  baseNode: WorkflowNode | null;
  changes: Changes;
  invalid: Record<string, string>;
  saving: boolean;
}

const useDraft = create<DraftState>(() => ({ nodeId: null, baseRevision: 0, baseNode: null, changes: {}, invalid: {}, saving: false }));

export const draftState = {
  use: useDraft,
  useDirty: () => useDraft((s) => Object.keys(s.changes).length > 0),

  /** Ensure the draft tracks `node`; discards a clean draft for another node. */
  track(node: WorkflowNode | null, revision: number) {
    const s = useDraft.getState();
    if (!node) {
      if (!Object.keys(s.changes).length) useDraft.setState({ nodeId: null, baseNode: null, baseRevision: revision });
      return;
    }
    if (s.nodeId === node.id && Object.keys(s.changes).length) return; // keep dirty draft
    if (s.nodeId !== node.id || s.baseRevision !== revision) useDraft.setState({ nodeId: node.id, baseNode: structuredClone(node), baseRevision: revision, changes: {}, invalid: {} });
  },

  /** Current value of a field: draft change or stored node. */
  value<K extends keyof Changes>(node: WorkflowNode, key: K): WorkflowNode[K] {
    const s = useDraft.getState();
    return (s.nodeId === node.id && key in s.changes ? s.changes[key] : node[key]) as WorkflowNode[K];
  },

  set<K extends keyof Changes>(node: WorkflowNode, key: K, value: WorkflowNode[K]) {
    const s = useDraft.getState();
    const base = s.nodeId === node.id ? s : { nodeId: node.id, baseNode: structuredClone(node), baseRevision: useStore.getState().wf!.revision, changes: {}, invalid: {} };
    const changes = { ...base.changes } as Changes;
    if (stableStringify(value) === stableStringify(base.baseNode![key])) delete changes[key];
    else changes[key] = value;
    useDraft.setState({ ...base, changes });
  },

  setConfig<K extends keyof WorkflowNode['config']>(node: WorkflowNode, key: K, value: WorkflowNode['config'][K]) {
    const cfg = { ...draftState.value(node, 'config'), [key]: value };
    draftState.set(node, 'config', cfg);
  },

  setInvalid(field: string, message: string | null) {
    const inv = { ...useDraft.getState().invalid };
    if (message) inv[field] = message;
    else delete inv[field];
    useDraft.setState({ invalid: inv });
  },

  discard() {
    const s = useDraft.getState();
    const wf = useStore.getState().wf;
    const node = wf?.nodes.find((n) => n.id === s.nodeId) ?? null;
    useDraft.setState({ changes: {}, invalid: {}, baseNode: node ? structuredClone(node) : null, baseRevision: wf?.revision ?? 0 });
  },

  async save(opts: { force?: boolean } = {}) {
    const s = useDraft.getState();
    if (!s.nodeId || !Object.keys(s.changes).length) return;
    const bad = Object.entries(s.invalid);
    if (bad.length) {
      useStore.getState().toast('error', `Fix invalid fields first: ${bad.map(([k, v]) => `${k}: ${v}`).join('; ')}`);
      return;
    }
    const store = useStore.getState();
    const { config, ...rest } = s.changes;
    useDraft.setState({ saving: true });
    const ok = await store.patch(
      [{ op: 'update_node', nodeId: s.nodeId, changes: { ...rest, ...(config ? { config } : {}) } }],
      `edit ${s.baseNode?.label ?? s.nodeId}`,
      { baseRevision: opts.force ? store.wf!.revision : s.baseRevision },
    );
    useDraft.setState({ saving: false });
    if (ok) {
      const wf = useStore.getState().wf!;
      const node = wf.nodes.find((n) => n.id === s.nodeId) ?? null;
      useDraft.setState({ changes: {}, invalid: {}, baseNode: node ? structuredClone(node) : null, baseRevision: wf.revision });
      store.toast('success', 'Saved');
    } else {
      // Offer an explicit, informed re-apply on the latest revision.
      const c = useStore.getState().conflict;
      if (c) useStore.getState().set({ conflict: { ...c, retry: () => draftState.save({ force: true }) } });
    }
  },
};
