import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { downstreamOf, newId, portsCompatible, templateByKey, upstreamOf, type WorkflowNode } from '@nodepilot/shared';
import { useStore } from '../store';
import { implBadge, KIND_ICON, nodeStatus, StatusChip } from '../status';

type CardData = {
  node: WorkflowNode;
  status: ReturnType<typeof nodeStatus>;
  issues: { level: string; message: string }[];
  flash: boolean;
  dim: boolean;
};
type CardNode = Node<CardData, 'np'>;

const NodeCard = memo(function NodeCard({ data, selected }: NodeProps<CardNode>) {
  const { node, status, issues, flash, dim } = data;
  const badge = implBadge(node);
  const blocking = issues.filter((i) => i.level !== 'warning');
  const tone = status ? `st-${status.status}` : '';
  return (
    <div
      className={`np-node ${tone}${selected ? ' selected' : ''}${flash ? ' flash' : ''}${dim ? ' dim' : ''}`}
      style={node.display.color ? ({ '--accent': node.display.color } as React.CSSProperties) : undefined}
      aria-label={`${node.label}, ${node.kind}${status ? `, ${status.status}` : ''}`}
    >
      <div className="np-node-head">
        <span className="np-kind" aria-hidden="true">{KIND_ICON[node.kind] ?? '•'}</span>
        <div className="np-title">
          <div className="np-label" title={node.label}>{node.label}</div>
          <div className="np-sub">{node.kind}</div>
        </div>
        <span className={`badge tone-${badge.tone}`} title={badge.title}>{badge.text}</span>
      </div>
      {(status || blocking.length > 0) && (
        <div className="np-node-status">
          {status && <StatusChip status={status.status} title={status.detail} small />}
          {status?.source === 'external' && <span className="badge tone-ext" title="From external telemetry">EXT</span>}
          {blocking.length > 0 && (
            <span className="chip chip-sm tone-warn" title={blocking.map((i) => i.message).join('\n')}>
              <span aria-hidden="true">⚠</span> {blocking.length} issue{blocking.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}
      {!node.display.collapsed && (
        <div className="np-ports">
          <div className="np-port-col">
            {node.inputs.map((p) => (
              <div className="np-port in" key={p.id} title={`${p.label}: ${p.type}${p.required ? ' (required)' : ''}${p.multiple ? `, multiple (${p.merge})` : ''}`}>
                <Handle type="target" position={Position.Left} id={p.id} className={`h-${p.type}`} />
                <span className="pl">{p.label}{p.required ? '' : '?'}</span>
                <span className={`pt t-${p.type}`}>{p.type}{p.multiple ? '[]' : ''}</span>
              </div>
            ))}
          </div>
          <div className="np-port-col right">
            {node.outputs.map((p) => (
              <div className="np-port out" key={p.id} title={`${p.label}: ${p.type}`}>
                <span className={`pt t-${p.type}`}>{p.type}</span>
                <span className="pl">{p.label}</span>
                <Handle type="source" position={Position.Right} id={p.id} className={`h-${p.type}`} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

const nodeTypes = { np: NodeCard };

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
  const rf = useReactFlow();
  const [nodes, setNodes] = useState<CardNode[]>([]);
  const [flashOn, setFlashOn] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const fittedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!remoteFlash) return;
    setFlashOn(true);
    const t = setTimeout(() => setFlashOn(false), 2500);
    return () => clearTimeout(t);
  }, [remoteFlash]);

  // Path highlighting for the selected node (actual graph structure, not activity).
  const pathSets = useMemo(() => {
    if (!wf || !selectedNodeId) return null;
    return { up: upstreamOf(wf, selectedNodeId), down: downstreamOf(wf, selectedNodeId) };
  }, [wf, selectedNodeId]);

  useEffect(() => {
    if (!wf) return setNodes([]);
    setNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      return wf.nodes.map((n) => {
        const p = prevMap.get(n.id);
        const dim = !!pathSets && n.id !== selectedNodeId && !pathSets.up.has(n.id) && !pathSets.down.has(n.id);
        return {
          ...(p ?? {}),
          id: n.id,
          type: 'np' as const,
          position: p?.dragging ? p.position : n.position,
          selected: n.id === selectedNodeId,
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
  }, [wf, validation, overlay, runDetail, externalRuns, selectedNodeId, pathSets, flashOn, remoteFlash]);

  useEffect(() => {
    if (wf && fittedFor.current !== wf.id && nodes.length && nodes.every((n) => n.measured)) {
      fittedFor.current = wf.id;
      // Keep cards readable on first view; large graphs can be panned or fitted fully with F.
      void rf.fitView({ padding: 0.12, duration: 0, minZoom: 0.6 });
    }
  }, [wf, nodes, rf]);

  const edges: Edge[] = useMemo(() => {
    if (!wf) return [];
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    return wf.edges.map((e) => {
      const classes: string[] = [];
      let animated = false;
      let label: string | undefined;
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

  if (!wf) return <div className="canvas-empty">No workflow selected.</div>;

  return (
    <div className="canvas" ref={wrapper} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow<CardNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_e, _n, dragged) => {
          const ops = dragged
            .map((n) => ({ op: 'move_node' as const, nodeId: n.id, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } }))
            .filter((op) => {
              const orig = wf.nodes.find((x) => x.id === op.nodeId)?.position;
              return !orig || orig.x !== op.position.x || orig.y !== op.position.y;
            });
          if (ops.length) void patch(ops, ops.length > 1 ? `move ${ops.length} nodes` : 'move node');
        }}
        onNodeClick={(_e, n) => select(n.id)}
        onEdgeClick={(_e, e) => select(null, e.id)}
        onPaneClick={() => select(null)}
        onNodesDelete={(ns) => void patch(ns.map((n) => ({ op: 'remove_node' as const, nodeId: n.id })), ns.length > 1 ? `delete ${ns.length} nodes` : 'delete node')}
        onEdgesDelete={(es) => {
          const removedNodes = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
          const ops = es.filter((e) => !removedNodes.has(e.source) && !removedNodes.has(e.target)).map((e) => ({ op: 'remove_edge' as const, edgeId: e.id }));
          if (ops.length) void patch(ops, 'delete connection');
        }}
        isValidConnection={isValidConnection}
        onConnect={onConnect}
        deleteKeyCode={['Delete', 'Backspace']}
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        nodesFocusable
        edgesFocusable
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#2a2f38" />
        <MiniMap pannable zoomable nodeColor={(n) => minimapColor((n.data as CardData).status?.status)} maskColor="rgba(8,10,13,0.7)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {wf.isExample && <div className="canvas-banner">Illustrative example workflow — not inferred from your repository. All nodes run deterministic demo handlers.</div>}
    </div>
  );
}

function minimapColor(status?: string) {
  switch (status) {
    case 'succeeded': return '#4fb477';
    case 'failed': return '#e5534b';
    case 'running': case 'started': return '#539bf5';
    case 'skipped': case 'retrying': return '#c69026';
    default: return '#3b4250';
  }
}
