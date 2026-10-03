import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as RMouseEvent } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  SelectionMode,
} from '@xyflow/react';
import { downstreamOf, newId, portsCompatible, templateByKey, upstreamOf, type InputPort, type OutputPort, type WorkflowNode } from '@nodepilot/shared';
import { useStore } from '../store';
import { DOT, dotFor, implBadge, KIND_ICON, nodeStatus, StatusChip, type Dot } from '../status';
import { DASHED_KINDS, KIND_COLOR, SHAPE_OF } from './shapes';
import { ToolRail } from './ToolRail';
import { NodeFooter } from './NodeFooter';

type CardData = {
  node: WorkflowNode;
  status: ReturnType<typeof nodeStatus>;
  issues: { level: string; message: string }[];
  flash: boolean;
  dim: boolean;
};
type CardNode = Node<CardData, 'np'>;

const GROUP_MIN = { w: 160, h: 120 };

function modelsOf(n: WorkflowNode): string[] {
  const m = (n.config.params as { models?: unknown }).models;
  const list = Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
  const impl = n.config.implementation;
  return impl.kind === 'model' ? [impl.model, ...list.filter((x) => x !== impl.model)] : list;
}

/** "openai/gpt-6-luna" → "gpt-6-luna" */
const shortModel = (m: string) => m.split('/').pop() ?? m;

function StatusDot({ dot, detail }: { dot: Dot; detail?: string }) {
  const d = DOT[dot];
  return <span className={`np-dot dot dot-${dot}`} role="img" aria-label={`Status: ${d.label}`} title={`${d.label}${detail ? ` — ${detail}` : ` — ${d.hint}`}`} />;
}

/** Spreads handles evenly along a side for shapes without port rows. */
function SideHandles({ ports, type }: { ports: (InputPort | OutputPort)[]; type: 'source' | 'target' }) {
  return (
    <>
      {ports.map((p, i) => (
        <Handle
          key={p.id}
          type={type}
          position={type === 'target' ? Position.Left : Position.Right}
          id={p.id}
          className={`h-${p.type}`}
          style={{ top: `${((i + 1) / (ports.length + 1)) * 100}%` }}
          title={`${p.label}: ${p.type}`}
        />
      ))}
    </>
  );
}

function RulesHandles({ ports }: { ports: InputPort[] }) {
  return (
    <>
      {ports.map((p, i) => (
        <Handle key={p.id} type="target" position={Position.Top} id={p.id} className="h-rules" style={{ left: `${((i + 1) / (ports.length + 1)) * 100}%` }} title="Instructions / rules attach here" />
      ))}
    </>
  );
}

const NodeView = memo(function NodeView({ data, selected, id }: NodeProps<CardNode>) {
  const { node, status, issues, flash, dim } = data;
  const shape = SHAPE_OF[node.kind] ?? 'rect';
  const blocking = issues.filter((i) => i.level !== 'warning');
  const dot = dotFor(status?.status, blocking.length);
  const detail = status?.detail ?? (blocking.length ? blocking.map((i) => i.message).join('\n') : undefined);
  const rulesIn = node.inputs.filter((p) => p.type === 'rules');
  const dataIn = node.inputs.filter((p) => p.type !== 'rules');
  const cls = `np-node shape-${shape}${selected ? ' selected' : ''}${flash ? ' flash' : ''}${dim ? ' dim' : ''}${status ? ` st-${status.status}` : ''}`;
  const style = { '--kc': node.display.color ?? KIND_COLOR[node.kind] ?? '#3b4250' } as CSSProperties;
  const aria = `${node.label}, ${node.kind}, ${DOT[dot].label}`;

  if (shape === 'container') return <GroupView node={node} selected={selected} nodeId={id} dim={dim} />;

  if (shape === 'circle') {
    return (
      <div className={cls} style={style} aria-label={aria}>
        <SideHandles ports={dataIn} type="target" />
        <div className="circle-text">
          <b>{node.kind === 'input' ? 'I/P' : 'O/P'}</b>
          <span title={node.label}>{node.label}</span>
        </div>
        <SideHandles ports={node.outputs} type="source" />
        <StatusDot dot={dot} detail={detail} />
      </div>
    );
  }

  if (shape === 'parallelogram') {
    const preview = (node.instructions || node.purpose).replace(/\s+/g, ' ').trim().slice(0, 70);
    return (
      <div className={cls} style={style} aria-label={aria}>
        <RulesHandles ports={rulesIn} />
        <SideHandles ports={dataIn} type="target" />
        <div className="para-bg" aria-hidden="true" />
        <div className="para-text">
          <span className="para-label" title={node.label}>{node.label}</span>
          {preview && <span className="para-sub">{preview}</span>}
        </div>
        {node.outputs.map((p, i) => (
          <Handle key={p.id} type="source" position={Position.Bottom} id={p.id} className={`h-${p.type}`} style={{ left: `${((i + 1) / (node.outputs.length + 1)) * 100}%` }} title={`${p.label}: ${p.type}`} />
        ))}
        <StatusDot dot={dot} detail={detail} />
      </div>
    );
  }

  if (shape === 'diamond' || shape === 'cylinder') {
    return (
      <div className={cls} style={style} aria-label={aria}>
        <RulesHandles ports={rulesIn} />
        <SideHandles ports={dataIn} type="target" />
        <div className={shape === 'diamond' ? 'diamond-bg' : 'cyl-bg'} aria-hidden="true" />
        <div className="shape-text">
          <span className="shape-label" title={node.label}>{node.label}</span>
          {shape === 'cylinder' && <span className="shape-sub">{node.kind}</span>}
        </div>
        <SideHandles ports={node.outputs} type="source" />
        <StatusDot dot={dot} detail={detail} />
      </div>
    );
  }

  // rect / dashed: ComfyUI-style card
  const badge = implBadge(node);
  const models = modelsOf(node);
  return (
    <div className={cls} style={style} aria-label={aria}>
      <RulesHandles ports={rulesIn} />
      <div className="np-card">
      <div className="np-head">
        <span className="np-kind" aria-hidden="true">{KIND_ICON[node.kind] ?? '•'}</span>
        <span className="np-label" title={node.label}>{node.label}</span>
        <span className={`badge tone-${badge.tone}`} title={badge.title}>{badge.text}</span>
      </div>
      {models.length > 0 && (
        <div className="np-models" title={models.join('\n')}>
          {models.slice(0, 2).map((m) => <span key={m} className="np-model">{shortModel(m)}</span>)}
          {models.length > 2 && <span className="np-model more">+{models.length - 2}</span>}
        </div>
      )}
      {(status || blocking.length > 0) && (
        <div className="np-node-status">
          {status && <StatusChip status={status.status} title={status.detail} small />}
          {status?.source === 'external' && <span className="badge tone-ext" title="From the original project's telemetry">EXT</span>}
          {blocking.length > 0 && (
            <span className="chip chip-sm tone-warn" title={blocking.map((i) => i.message).join('\n')}>
              <span aria-hidden="true">⚠</span> {blocking.length} issue{blocking.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}
      {!node.display.collapsed && (dataIn.length > 0 || node.outputs.length > 0) && (
        <div className="np-ports">
          <div className="np-port-col">
            {dataIn.map((p) => (
              <div className="np-port in" key={p.id} title={`${p.label}: ${p.type}${p.required ? ' (required)' : ''}${p.multiple ? `, multiple (${p.merge})` : ''}`}>
                <Handle type="target" position={Position.Left} id={p.id} className={`h-${p.type}`} />
                <span className="pl">{p.label}{p.required ? '' : '?'}</span>
              </div>
            ))}
          </div>
          <div className="np-port-col right">
            {node.outputs.map((p) => (
              <div className="np-port out" key={p.id} title={`${p.label}: ${p.type}`}>
                <span className="pl">{p.label}</span>
                <Handle type="source" position={Position.Right} id={p.id} className={`h-${p.type}`} />
              </div>
            ))}
          </div>
        </div>
      )}
      </div>
      <NodeFooter node={node} dot={dot} detail={detail} />
    </div>
  );
});

function GroupView({ node, selected, nodeId, dim }: { node: WorkflowNode; selected: boolean; nodeId: string; dim: boolean }) {
  const patch = useStore((s) => s.patch);
  return (
    <div className={`np-node shape-container${selected ? ' selected' : ''}${dim ? ' dim' : ''}`} aria-label={`${node.label}, group`}>
      <NodeResizer
        isVisible={selected}
        minWidth={GROUP_MIN.w}
        minHeight={GROUP_MIN.h}
        lineClassName="group-resize-line"
        handleClassName="group-resize-handle"
        onResizeEnd={(_e, p) => {
          void patch([
            { op: 'set_node_display', nodeId, display: { width: Math.round(p.width), height: Math.round(p.height) } },
            { op: 'move_node', nodeId, position: { x: Math.round(p.x), y: Math.round(p.y) } },
          ], 'resize group');
        }}
      />
      <div className="group-title">{node.label}</div>
    </div>
  );
}

const nodeTypes = { np: NodeView };

export function Canvas() {
  const wf = useStore((s) => s.wf);
  const validation = useStore((s) => s.validation);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const selectedEdgeId = useStore((s) => s.selectedEdgeId);
  const overlay = useStore((s) => s.overlay);
  const runDetail = useStore((s) => s.runDetail);
  const externalRuns = useStore((s) => s.externalRuns);
  const remoteFlash = useStore((s) => s.remoteFlash);
  const select = useStore((s) => s.select);
  const patch = useStore((s) => s.patch);
  const set = useStore((s) => s.set);
  const togglePanel = useStore((s) => s.togglePanel);
  const tool = useStore((s) => s.tool);
  const multiSelected = useStore((s) => s.multiSelected);
  const toast = useStore((s) => s.toast);
  const rf = useReactFlow();
  const [nodes, setNodes] = useState<CardNode[]>([]);
  const [flashOn, setFlashOn] = useState(false);
  const fittedFor = useRef<string | null>(null);
  /** Nodes carried along while a group is dragged. */
  const groupDrag = useRef<{ id: string; start: { x: number; y: number }; members: Map<string, { x: number; y: number }> } | null>(null);

  useEffect(() => {
    if (!remoteFlash) return;
    setFlashOn(true);
    const t = setTimeout(() => setFlashOn(false), 2500);
    return () => clearTimeout(t);
  }, [remoteFlash]);

  // Path highlighting for the selected node (actual graph structure, not activity).
  const pathSets = useMemo(() => {
    if (!wf || !selectedNodeId) return null;
    if (wf.nodes.find((n) => n.id === selectedNodeId)?.kind === 'group') return null;
    return { up: upstreamOf(wf, selectedNodeId), down: downstreamOf(wf, selectedNodeId) };
  }, [wf, selectedNodeId]);

  useEffect(() => {
    if (!wf) return setNodes([]);
    setNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      // Groups first so they render behind their members.
      const ordered = [...wf.nodes].sort((a, b) => Number(b.kind === 'group') - Number(a.kind === 'group'));
      return ordered.map((n) => {
        const p = prevMap.get(n.id);
        const isGroup = n.kind === 'group';
        const dim = !!pathSets && !isGroup && n.id !== selectedNodeId && !pathSets.up.has(n.id) && !pathSets.down.has(n.id);
        const size = isGroup ? { width: n.display.width ?? 300, height: n.display.height ?? 360 } : {};
        return {
          ...(p ?? {}),
          ...size,
          id: n.id,
          type: 'np' as const,
          position: p?.dragging || p?.resizing ? p.position : n.position,
          selected: n.id === selectedNodeId || multiSelected.includes(n.id),
          zIndex: isGroup ? 0 : 1,
          data: {
            node: n,
            status: nodeStatus(n.id, overlay, runDetail, externalRuns),
            issues: (validation?.issues ?? []).filter((i) => i.nodeId === n.id),
            flash: flashOn && !!remoteFlash?.nodeIds.includes(n.id),
            dim,
          },
        } as CardNode;
      });
    });
  }, [wf, validation, overlay, runDetail, externalRuns, selectedNodeId, multiSelected, pathSets, flashOn, remoteFlash]);

  useEffect(() => {
    if (wf && fittedFor.current !== wf.id && nodes.length && nodes.every((n) => n.measured)) {
      fittedFor.current = wf.id;
      void rf.fitView({ padding: 0.12, duration: 0, minZoom: 0.35, maxZoom: 1 });
    }
  }, [wf, nodes, rf]);

  const edges: Edge[] = useMemo(() => {
    if (!wf) return [];
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const kindOf = new Map(wf.nodes.map((n) => [n.id, n.kind]));
    return wf.edges.map((e) => {
      const classes: string[] = [];
      let animated = false;
      let label: string | undefined;
      if (DASHED_KINDS.has(kindOf.get(e.source) ?? '') || DASHED_KINDS.has(kindOf.get(e.target) ?? '') || e.targetPort === 'rules') classes.push('edge-dashed');
      if (e.targetPort === 'rules') classes.push('edge-rules');
      // Execution-state edges are derived only from recorded node states.
      const s = nodeStatus(e.source, overlay, runDetail, externalRuns)?.status;
      const t = nodeStatus(e.target, overlay, runDetail, externalRuns)?.status;
      if (s === 'succeeded' && (t === 'running' || t === 'retrying' || t === 'started')) {
        classes.push('edge-flowing');
        animated = !reduced;
        label = 'data delivered → running';
      } else if (s === 'succeeded' && t) classes.push(t === 'succeeded' ? 'edge-delivered' : 'edge-ended');
      else if (s === 'failed' || s === 'skipped' || s === 'cancelled') classes.push('edge-blocked');
      if (pathSets) {
        const onPath = (pathSets.up.has(e.source) || e.source === selectedNodeId) && (pathSets.up.has(e.target) || e.target === selectedNodeId)
          || (pathSets.down.has(e.target) || e.target === selectedNodeId) && (pathSets.down.has(e.source) || e.source === selectedNodeId);
        classes.push(onPath ? 'edge-path' : 'edge-dim');
      }
      const sel = e.id === selectedEdgeId;
      return {
        id: e.id,
        source: e.source,
        sourceHandle: e.sourcePort,
        target: e.target,
        targetHandle: e.targetPort,
        className: classes.join(' '),
        animated,
        selected: sel,
        zIndex: 1,
        label: sel ? `${e.sourcePort} → ${e.targetPort}` : undefined,
        data: { stateLabel: label },
        ariaLabel: `Connection ${e.source}.${e.sourcePort} to ${e.target}.${e.targetPort}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      } as Edge;
    });
  }, [wf, overlay, runDetail, externalRuns, pathSets, selectedNodeId, selectedEdgeId]);

  const onNodesChange = useCallback((changes: NodeChange<CardNode>[]) => {
    // Removal goes through onNodesDelete → server; selection through onSelectionChange.
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), ns));
  }, []);

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (!wf || !c.source || !c.target || c.source === c.target) return false;
      const src = wf.nodes.find((n) => n.id === c.source);
      const tgt = wf.nodes.find((n) => n.id === c.target);
      const sp = src?.outputs.find((p) => p.id === c.sourceHandle);
      const tp = tgt?.inputs.find((p) => p.id === c.targetHandle);
      if (!sp || !tp || !portsCompatible(sp.type, tp.type)) return false;
      if (!tp.multiple && wf.edges.some((e) => e.target === c.target && e.targetPort === c.targetHandle)) return false;
      if (downstreamOf(wf, c.target).has(c.source)) return false; // would create a cycle
      return true;
    },
    [wf],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      void patch([{ op: 'add_edge', edge: { id: newId('e'), source: c.source, sourcePort: c.sourceHandle, target: c.target, targetPort: c.targetHandle } }], 'connect');
    },
    [patch],
  );

  const onDragOver = (ev: DragEvent) => {
    if (ev.dataTransfer.types.includes('application/x-nodepilot-template')) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = (ev: DragEvent) => {
    const key = ev.dataTransfer.getData('application/x-nodepilot-template');
    const tpl = key && templateByKey(key);
    if (!tpl) return;
    ev.preventDefault();
    const pos = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    const id = newId('n');
    void patch([{ op: 'add_node', node: tpl.build(id, { x: Math.round(pos.x), y: Math.round(pos.y) }) }], `add ${tpl.label}`).then((ok) => ok && select(id));
  };
  const onDoubleClick = (ev: RMouseEvent) => {
    if (tool !== 'hand' && (ev.target as HTMLElement).classList.contains('react-flow__pane')) set({ nodeSearch: { x: ev.clientX, y: ev.clientY } });
  };

  if (!wf) return <div className="canvas-empty">No workflow selected.</div>;

  return (
    <div className={`canvas tool-${tool}`} onDragOver={onDragOver} onDrop={onDrop} onDoubleClick={onDoubleClick}>
      <ReactFlow<CardNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={(_e, n) => {
          const g = n.data.node;
          if (g.kind !== 'group') return (groupDrag.current = null);
          const w = g.display.width ?? 300;
          const h = g.display.height ?? 360;
          const members = new Map(
            wf.nodes
              .filter((x) => x.kind !== 'group' && x.position.x >= g.position.x && x.position.y >= g.position.y && x.position.x < g.position.x + w && x.position.y < g.position.y + h)
              .map((x) => [x.id, { ...x.position }]),
          );
          groupDrag.current = { id: n.id, start: { ...n.position }, members };
        }}
        onNodeDrag={(_e, n) => {
          const gd = groupDrag.current;
          if (!gd || gd.id !== n.id) return;
          const dx = n.position.x - gd.start.x;
          const dy = n.position.y - gd.start.y;
          setNodes((ns) => ns.map((x) => {
            const m = gd.members.get(x.id);
            return m ? { ...x, position: { x: m.x + dx, y: m.y + dy } } : x;
          }));
        }}
        onNodeDragStop={(_e, _n, dragged) => {
          const gd = groupDrag.current;
          groupDrag.current = null;
          const moved = new Map(dragged.map((n) => [n.id, n.position]));
          if (gd) {
            const g = dragged.find((n) => n.id === gd.id);
            if (g) {
              const dx = g.position.x - gd.start.x;
              const dy = g.position.y - gd.start.y;
              for (const [id, p] of gd.members) if (!moved.has(id)) moved.set(id, { x: p.x + dx, y: p.y + dy });
            }
          }
          const ops = [...moved]
            .map(([nodeId, p]) => ({ op: 'move_node' as const, nodeId, position: { x: Math.round(p.x), y: Math.round(p.y) } }))
            .filter((op) => {
              const orig = wf.nodes.find((x) => x.id === op.nodeId)?.position;
              return !orig || orig.x !== op.position.x || orig.y !== op.position.y;
            });
          if (ops.length) void patch(ops, ops.length > 1 ? `move ${ops.length} nodes` : 'move node');
        }}
        onNodeClick={(e, n) => { if (tool !== 'hand' && !e.shiftKey && !e.ctrlKey && !e.metaKey) select(n.id); }}
        onNodeDoubleClick={(_e, n) => { if (tool === 'hand') return; select(n.id); togglePanel('inspector', true); }}
        onEdgeClick={(_e, e) => {
          if (tool === 'hand') return;
          // Connections are only removed with the node tool.
          if (tool === 'node') void patch([{ op: 'remove_edge', edgeId: e.id }], 'delete connection').then((ok) => ok && toast('info', 'Connection removed (Ctrl+Z to undo)'));
          else select(null, e.id);
        }}
        onPaneClick={(e) => {
          if (tool === 'node') set({ nodeSearch: { x: e.clientX, y: e.clientY }, selectedNodeId: null, selectedEdgeId: null, multiSelected: [] });
          else if (tool !== 'hand') select(null);
        }}
        onSelectionChange={({ nodes: sel }) => {
          // Mirror rectangle / shift-click selections into the store.
          const ids = sel.map((n) => n.id);
          const st = useStore.getState();
          if (ids.length > 1 && (ids.length !== st.multiSelected.length || ids.some((id) => !st.multiSelected.includes(id)))) set({ multiSelected: ids, selectedNodeId: null, selectedEdgeId: null });
          else if (ids.length === 1 && st.multiSelected.length > 1) set({ multiSelected: [], selectedNodeId: ids[0] });
        }}
        onNodesDelete={(ns) => void patch(ns.map((n) => ({ op: 'remove_node' as const, nodeId: n.id })), ns.length > 1 ? `delete ${ns.length} nodes` : 'delete node')}
        onEdgesDelete={(es) => {
          const removedNodes = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
          const ops = es.filter((e) => !removedNodes.has(e.source) && !removedNodes.has(e.target)).map((e) => ({ op: 'remove_edge' as const, edgeId: e.id }));
          if (!ops.length) return;
          if (tool !== 'node') return toast('info', 'Switch to the node tool (N) to remove connections.');
          void patch(ops, ops.length > 1 ? `delete ${ops.length} connections` : 'delete connection');
        }}
        isValidConnection={isValidConnection}
        onConnect={onConnect}
        deleteKeyCode={['Delete', 'Backspace']}
        zoomOnDoubleClick={false}
        panOnDrag={tool === 'hand' ? true : [1]}
        selectionOnDrag={tool === 'marquee'}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        nodesDraggable={tool !== 'hand'}
        nodesConnectable={tool === 'node'}
        elementsSelectable={tool !== 'hand'}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        nodesFocusable
        edgesFocusable
      >
        <Background id="grid-minor" variant={BackgroundVariant.Lines} gap={24} lineWidth={1} color="var(--grid-minor)" />
        <Background id="grid-major" variant={BackgroundVariant.Lines} gap={120} lineWidth={1} color="var(--grid-major)" />
        <MiniMap pannable zoomable nodeColor={(n) => minimapColor(n.data as CardData)} maskColor="rgba(8,10,13,0.7)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {wf.isExample && <div className="canvas-banner">Illustrative example workflow, not inferred from your repository. All nodes run deterministic demo handlers.</div>}
      {wf.nodes.length === 0 && (
        <div className="canvas-start">
          <div className="canvas-start-card">
            <h2>Start from your project</h2>
            <p className="muted">Paste a git link or upload the project folder. Its files are read and turned into an initial node structure you can edit.</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => set({ dialog: 'import' })}>⇪ Import project</button>
              <button className="btn" onClick={(e) => set({ nodeSearch: { x: e.clientX, y: e.clientY + 20 } })}>＋ Add a node</button>
            </div>
            <p className="muted small">Tip: double-click the grid, or pick the node tool ↗ and click, to add a node.</p>
          </div>
        </div>
      )}
      <ToolRail />
      <Legend />
    </div>
  );
}

function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`legend${open ? ' open' : ''}`}>
      <button className="btn ghost xs" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '▾' : '▸'} Legend</button>
      {open && (
        <div className="legend-body">
          <div className="legend-row"><span className="lg lg-circle" />Input / output</div>
          <div className="legend-row"><span className="lg lg-rect" />Main step (model, planner, judge…)</div>
          <div className="legend-row"><span className="lg lg-dashed" />Optional side check</div>
          <div className="legend-row"><span className="lg lg-para" />Instructions / rules</div>
          <div className="legend-row"><span className="lg lg-diamond" />Router</div>
          <div className="legend-row"><span className="lg lg-cyl" />Data store</div>
          <div className="legend-row"><span className="lg lg-group" />Ensemble group</div>
          <hr />
          {(Object.keys(DOT) as Dot[]).map((d) => (
            <div className="legend-row" key={d}><span className={`dot dot-${d}`} />{DOT[d].label}<span className="muted xs"> · {DOT[d].hint}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

function minimapColor(d?: CardData) {
  if (d?.node.kind === 'group') return 'rgba(60,66,80,0.35)';
  switch (d?.status?.status) {
    case 'succeeded': return '#4fb477';
    case 'failed': return '#e5534b';
    case 'running': case 'started': return '#539bf5';
    case 'skipped': case 'retrying': return '#c69026';
    default: return KIND_COLOR[d?.node.kind ?? ''] ?? '#3b4250';
  }
}
