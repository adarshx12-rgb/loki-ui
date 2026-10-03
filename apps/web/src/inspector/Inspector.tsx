import { useEffect, useState } from 'react';
import {
  DEMO_HANDLERS,
  NODE_KINDS,
  PORT_TYPES,
  newId,
  postProcessStepSchema,
  stableStringify,
  type CodeRef,
  type Implementation,
  type InputPort,
  type OutputPort,
  type WorkflowNode,
} from '@nodepilot/shared';
import { z } from 'zod';
import { api, enc } from '../api';
import { Markdown } from '../components/Markdown';
import { useStore } from '../store';
import { fmtAgo, fmtMs, fmtTime, implBadge, KIND_ICON, StatusChip, useNodeStatus } from '../status';
import { draftState } from './draft';

const TABS = [
  ['overview', 'Overview'],
  ['config', 'Configuration'],
  ['notes', 'Notes'],
  ['instructions', 'Model instructions'],
  ['contracts', 'I/O contracts'],
  ['code', 'Code refs'],
  ['history', 'Run history'],
  ['events', 'Errors & events'],
] as const;

export function Inspector() {
  const wf = useStore((s) => s.wf);
  const nodeId = useStore((s) => s.selectedNodeId);
  const edgeId = useStore((s) => s.selectedEdgeId);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('overview');
  const node = wf?.nodes.find((n) => n.id === nodeId) ?? null;
  useDraft(node, wf?.revision ?? 0);

  if (!wf) return <aside className="inspector" />;
  if (edgeId) return <aside className="inspector" aria-label="Inspector"><EdgeInspector edgeId={edgeId} /></aside>;
  if (!node) return <aside className="inspector" aria-label="Inspector"><WorkflowOverview /></aside>;

  return (
    <aside className="inspector" aria-label={`Inspector: ${node.label}`}>
      <div className="insp-head">
        <span className="np-kind" aria-hidden="true">{KIND_ICON[node.kind]}</span>
        <div className="grow">
          <div className="insp-title">{node.label}</div>
          <div className="muted mono small">{node.id}</div>
        </div>
        <button className="btn ghost small" onClick={() => useStore.getState().set({ dialog: 'ask', askTarget: { nodeId: node.id } })} title="Ask Claude Code about this node">✦ Ask Claude</button>
      </div>
      <DraftBanner node={node} />
      <div className="tabs" role="tablist" aria-label="Inspector sections">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="tab-body" role="tabpanel">
        {tab === 'overview' && <Overview node={node} />}
        {tab === 'config' && <ConfigTab node={node} />}
        {tab === 'notes' && <MarkdownField node={node} field="notes" placeholder="Markdown notes for humans: decisions, caveats, links…" />}
        {tab === 'instructions' && <MarkdownField node={node} field="instructions" placeholder="Instructions sent to the model (system prompt for model nodes)." help="For model nodes these are sent as the system prompt. Changing them changes the executable hash." />}
        {tab === 'contracts' && <Contracts node={node} />}
        {tab === 'code' && <CodeRefs node={node} />}
        {tab === 'history' && <History node={node} />}
        {tab === 'events' && <NodeEvents node={node} />}
      </div>
    </aside>
  );
}

function useDraft(node: WorkflowNode | null, revision: number) {
  useEffect(() => draftState.track(node, revision), [node, revision]);
  draftState.use((s) => s.changes); // re-render on draft changes
}

function DraftBanner({ node }: { node: WorkflowNode }) {
  const d = draftState.use();
  const dirty = d.nodeId === node.id && Object.keys(d.changes).length > 0;
  const changedRemotely = dirty && d.baseNode && stableStringify({ ...d.baseNode, position: 0 }) !== stableStringify({ ...node, position: 0 });
  if (!dirty) return null;
  return (
    <div className={`banner ${changedRemotely ? 'warn' : 'info'}`} role="status">
      {changedRemotely ? (
        <span>⚠ This node changed elsewhere while you were editing. Saving will be checked against revision r{d.baseRevision}.</span>
      ) : (
        <span>Unsaved changes: {Object.keys(d.changes).join(', ')}</span>
      )}
      <span className="grow" />
      <button className="btn small" onClick={() => void draftState.save()} disabled={d.saving}>Save</button>
      <button className="btn ghost small" onClick={() => draftState.discard()}>Discard</button>
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ node }: { node: WorkflowNode }) {
  const status = useNodeStatus(node.id);
  const issues = (useStore((s) => s.validation)?.issues ?? []).filter((i) => i.nodeId === node.id);
  const badge = implBadge(node);
  const patch = useStore((s) => s.patch);
  return (
    <div className="form">
      <Field label="Label">
        <input className="input" value={draftState.value(node, 'label')} onChange={(e) => draftState.set(node, 'label', e.target.value)} />
      </Field>
      <Field label="Type">
        <select className="input" value={draftState.value(node, 'kind')} onChange={(e) => draftState.set(node, 'kind', e.target.value as WorkflowNode['kind'])}>
          {NODE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </Field>
      <Field label="Purpose">
        <textarea className="input" rows={3} value={draftState.value(node, 'purpose')} onChange={(e) => draftState.set(node, 'purpose', e.target.value)} placeholder="What this node is for" />
      </Field>
      <div className="kv">
        <span>Implementation</span>
        <span><span className={`badge tone-${badge.tone}`}>{badge.text}</span> <span className="muted small">{badge.title}</span></span>
        <span>Status</span>
        <span>{status ? <><StatusChip status={status.status} /> <span className="muted small">{status.source === 'external' ? 'external telemetry' : 'selected local run'}</span></> : <span className="muted">No run selected</span>}</span>
        {status?.detail && <><span>Detail</span><span className="mono small">{status.detail}</span></>}
      </div>
      {issues.length > 0 && (
        <ul className="issues">
          {issues.map((i, k) => <li key={k} className={`issue lvl-${i.level}`}><span aria-hidden="true">{i.level === 'warning' ? '△' : '⚠'}</span> <b>{i.level === 'save' ? 'Structural' : i.level === 'run' ? 'Blocks run' : 'Warning'}:</b> {i.message}</li>)}
        </ul>
      )}
      <fieldset className="fs">
        <legend>Display (visual only — never affects execution)</legend>
        <div className="row">
          <label className="row small">Accent
            <input type="color" value={node.display.color ?? '#7aa2f7'} onChange={(e) => void patch([{ op: 'set_node_display', nodeId: node.id, display: { color: e.target.value } }], 'restyle')} />
          </label>
          <label className="row small">
            <input type="checkbox" checked={!!node.display.collapsed} onChange={(e) => void patch([{ op: 'set_node_display', nodeId: node.id, display: { collapsed: e.target.checked } }], 'collapse')} /> Collapse ports
          </label>
          <span className="muted small mono">x {Math.round(node.position.x)}, y {Math.round(node.position.y)}</span>
        </div>
      </fieldset>
      <button className="btn danger small" onClick={() => { if (confirm(`Delete node "${node.label}" and its connections?`)) void patch([{ op: 'remove_node', nodeId: node.id }], 'delete node'); }}>Delete node</button>
    </div>
  );
}

// ---------------------------------------------------------------- configuration

function ConfigTab({ node }: { node: WorkflowNode }) {
  const cfg = draftState.value(node, 'config');
  const impl = cfg.implementation;
  const setImpl = (i: Implementation) => draftState.setConfig(node, 'implementation', i);
  return (
    <div className="form">
      <Field label="Implementation">
        <select
          className="input"
          value={impl.kind}
          onChange={(e) => {
            const k = e.target.value;
            if (k === 'demo') setImpl({ kind: 'demo', handler: 'echo' });
            if (k === 'model') setImpl({ kind: 'model', provider: 'anthropic', model: 'claude-haiku-4-5', maxTokens: 1024 });
            if (k === 'observed') setImpl({ kind: 'observed', serviceId: 'example-backend' });
            if (k === 'script') setImpl({ kind: 'script', language: 'javascript', source: '' });
            if (k === 'none') setImpl({ kind: 'none' });
          }}
        >
          <option value="demo">Demo handler (deterministic, local)</option>
          <option value="model">Model call (adapter)</option>
          <option value="observed">Observed external service</option>
          <option value="script">Custom script (draft only)</option>
          <option value="none">Not configured</option>
        </select>
      </Field>
      {impl.kind === 'demo' && (
        <Field label="Demo handler" help="Runs locally and labels its output as demo data.">
          <select className="input" value={impl.handler} onChange={(e) => setImpl({ ...impl, handler: e.target.value as never })}>
            {DEMO_HANDLERS.map((h) => <option key={h}>{h}</option>)}
          </select>
        </Field>
      )}
      {impl.kind === 'model' && (
        <>
          <Field label="Provider"><select className="input" value={impl.provider} onChange={() => undefined}><option>anthropic</option></select></Field>
          <Field label="Model"><input className="input mono" value={impl.model} onChange={(e) => setImpl({ ...impl, model: e.target.value })} /></Field>
          <Field label="Credential reference" help='"env:ANTHROPIC_API_KEY" or "secret:name" (store values under Connections → Secrets). Never paste a key here.'>
            <input className="input mono" value={impl.credentialRef ?? ''} placeholder="env:ANTHROPIC_API_KEY" onChange={(e) => setImpl({ ...impl, credentialRef: e.target.value || undefined })} />
          </Field>
          <Field label="Max tokens"><NumberInput value={impl.maxTokens} min={1} max={64000} onChange={(v) => setImpl({ ...impl, maxTokens: v })} /></Field>
        </>
      )}
      {impl.kind === 'observed' && (
        <>
          <div className="banner ext">◉ Observed nodes are implemented by an external backend. NodePilot shows their telemetry and never executes them.</div>
          <Field label="Service id"><input className="input mono" value={impl.serviceId} onChange={(e) => setImpl({ ...impl, serviceId: e.target.value })} /></Field>
        </>
      )}
      {impl.kind === 'script' && (
        <>
          <div className="banner warn">⚠ Custom script execution is <b>unavailable</b>. The text is stored as a draft only; it is never executed by the server, and NodePilot does not treat a JavaScript VM as a security sandbox. An isolated runner is required first.</div>
          <Field label="Language">
            <select className="input" value={impl.language} onChange={(e) => setImpl({ ...impl, language: e.target.value as 'javascript' | 'python' })}><option>javascript</option><option>python</option></select>
          </Field>
          <Field label="Script draft"><textarea className="input mono" rows={8} value={impl.source} onChange={(e) => setImpl({ ...impl, source: e.target.value })} spellCheck={false} /></Field>
        </>
      )}
      {impl.kind === 'none' && <div className="banner warn">This node shows “Not configured” and cannot run.</div>}

      <JsonField label="Parameters (JSON)" help="Handler parameters. Secrets are rejected — use a credential reference." value={cfg.params} schema={z.record(z.string(), z.unknown())} field="params" onValid={(v) => draftState.setConfig(node, 'params', v as Record<string, unknown>)} />

      <div className="grid2">
        <Field label="Timeout (ms)"><NumberInput value={cfg.timeoutMs} min={100} max={600000} onChange={(v) => draftState.setConfig(node, 'timeoutMs', v)} /></Field>
        <Field label="Max attempts"><NumberInput value={cfg.retry.maxAttempts} min={1} max={5} onChange={(v) => draftState.setConfig(node, 'retry', { ...cfg.retry, maxAttempts: v })} /></Field>
        <Field label="Retry backoff (ms)"><NumberInput value={cfg.retry.backoffMs} min={0} max={60000} onChange={(v) => draftState.setConfig(node, 'retry', { ...cfg.retry, backoffMs: v })} /></Field>
        <Field label="Safe to retry" help="Retries only happen for idempotent, side-effect-free work.">
          <label className="row"><input type="checkbox" checked={cfg.retry.safeToRetry} onChange={(e) => draftState.setConfig(node, 'retry', { ...cfg.retry, safeToRetry: e.target.checked })} /> idempotent</label>
        </Field>
      </div>

      {impl.kind === 'demo' && (
        <fieldset className="fs">
          <legend>Demo fault injection (labelled, for testing)</legend>
          <div className="grid2">
            <Field label="Fail mode">
              <select className="input" value={cfg.demo.failMode} onChange={(e) => draftState.setConfig(node, 'demo', { ...cfg.demo, failMode: e.target.value as 'none' })}>
                <option value="none">none</option><option value="error">error</option><option value="timeout">timeout</option>
              </select>
            </Field>
            <Field label="Latency (ms)"><NumberInput value={cfg.demo.latencyMs} min={0} max={10000} onChange={(v) => draftState.setConfig(node, 'demo', { ...cfg.demo, latencyMs: v })} /></Field>
          </div>
        </fieldset>
      )}

      <JsonField
        label="Post-processing steps (JSON)"
        help='Validated transformations applied to each output: select {fields}, map {mapping}, filter {path, where:{field,cmp,value}}, sort {path,by,order}, limit {path,count}. Example: [{"op":"select","fields":["report.mean"]}]'
        value={cfg.postProcess}
        schema={z.array(postProcessStepSchema).max(20)}
        field="postProcess"
        onValid={(v) => draftState.setConfig(node, 'postProcess', v as WorkflowNode['config']['postProcess'])}
      />
    </div>
  );
}

// ---------------------------------------------------------------- notes / instructions

function MarkdownField({ node, field, placeholder, help }: { node: WorkflowNode; field: 'notes' | 'instructions'; placeholder: string; help?: string }) {
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const value = draftState.value(node, field);
  return (
    <div className="form">
      <div className="row">
        <div className="seg" role="group" aria-label="Mode">
          <button className={`seg-btn${mode === 'preview' ? ' on' : ''}`} onClick={() => setMode('preview')}>Preview</button>
          <button className={`seg-btn${mode === 'edit' ? ' on' : ''}`} onClick={() => setMode('edit')}>Edit</button>
        </div>
        <span className="muted small">Markdown, rendered safely (scripts and HTML handlers are stripped)</span>
      </div>
      {help && <p className="muted small">{help}</p>}
      {mode === 'edit' ? (
        <textarea className="input mono" rows={16} value={value} placeholder={placeholder} onChange={(e) => draftState.set(node, field, e.target.value)} aria-label={field} />
      ) : (
        <div className="md-box" onDoubleClick={() => setMode('edit')}><Markdown text={value} /></div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- contracts

function Contracts({ node }: { node: WorkflowNode }) {
  const wf = useStore((s) => s.wf)!;
  const runDetail = useStore((s) => s.runDetail);
  const inputs = draftState.value(node, 'inputs');
  const outputs = draftState.value(node, 'outputs');
  const st = runDetail?.nodes[node.id];
  const updIn = (i: number, p: Partial<InputPort>) => draftState.set(node, 'inputs', inputs.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const updOut = (i: number, p: Partial<OutputPort>) => draftState.set(node, 'outputs', outputs.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <div className="form">
      <h4>Inputs</h4>
      <table className="tbl">
        <thead><tr><th>id</th><th>label</th><th>type</th><th>req</th><th>multi</th><th>merge</th><th>links</th><th /></tr></thead>
        <tbody>
          {inputs.map((p, i) => (
            <tr key={i}>
              <td><input className="input mono xs" value={p.id} onChange={(e) => updIn(i, { id: e.target.value })} /></td>
              <td><input className="input xs" value={p.label} onChange={(e) => updIn(i, { label: e.target.value })} /></td>
              <td><select className="input xs" value={p.type} onChange={(e) => updIn(i, { type: e.target.value as InputPort['type'] })}>{PORT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></td>
              <td><input type="checkbox" checked={p.required} onChange={(e) => updIn(i, { required: e.target.checked })} aria-label="required" /></td>
              <td><input type="checkbox" checked={p.multiple} onChange={(e) => updIn(i, { multiple: e.target.checked })} aria-label="multiple" /></td>
              <td><select className="input xs" value={p.merge} disabled={!p.multiple} onChange={(e) => updIn(i, { merge: e.target.value as InputPort['merge'] })}><option value="array">array</option><option value="object_by_source">by source</option></select></td>
              <td className="muted small">{wf.edges.filter((e) => e.target === node.id && e.targetPort === p.id).length}</td>
              <td><button className="btn ghost xs" aria-label={`Remove input ${p.id}`} onClick={() => draftState.set(node, 'inputs', inputs.filter((_, k) => k !== i))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn ghost small" onClick={() => draftState.set(node, 'inputs', [...inputs, { id: `in${inputs.length + 1}`, label: 'Input', type: 'any', required: true, multiple: false, merge: 'array' }])}>＋ Input</button>
      <h4>Outputs</h4>
      <table className="tbl">
        <thead><tr><th>id</th><th>label</th><th>type</th><th>links</th><th /></tr></thead>
        <tbody>
          {outputs.map((p, i) => (
            <tr key={i}>
              <td><input className="input mono xs" value={p.id} onChange={(e) => updOut(i, { id: e.target.value })} /></td>
              <td><input className="input xs" value={p.label} onChange={(e) => updOut(i, { label: e.target.value })} /></td>
              <td><select className="input xs" value={p.type} onChange={(e) => updOut(i, { type: e.target.value as OutputPort['type'] })}>{PORT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></td>
              <td className="muted small">{wf.edges.filter((e) => e.source === node.id && e.sourcePort === p.id).length}</td>
              <td><button className="btn ghost xs" aria-label={`Remove output ${p.id}`} onClick={() => draftState.set(node, 'outputs', outputs.filter((_, k) => k !== i))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn ghost small" onClick={() => draftState.set(node, 'outputs', [...outputs, { id: `out${outputs.length + 1}`, label: 'Output', type: 'json' }])}>＋ Output</button>
      <p className="muted small">Removing a port that still has connections is rejected on save. Type changes must stay compatible with connected ports.</p>
      {st && (
        <>
          <h4>Last observed values {st.demo && <span className="badge tone-info">DEMO DATA</span>} {st.truncated && <span className="badge tone-warn">TRUNCATED</span>}</h4>
          <p className="muted small">From the selected run, redacted and truncated.</p>
          <Pre label="Input" value={st.input} />
          <Pre label="Output" value={st.output} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- code references

interface Resolved { ref: CodeRef; absolutePath?: string; exists?: boolean; vscodeUrl?: string; error?: string }

function CodeRefs({ node }: { node: WorkflowNode }) {
  const wf = useStore((s) => s.wf)!;
  const refs = draftState.value(node, 'codeRefs');
  const [resolved, setResolved] = useState<Resolved[]>([]);
  useEffect(() => {
    void api.get<Resolved[]>(`/api/workflows/${enc(wf.id)}/nodes/${enc(node.id)}/coderefs`).then(setResolved).catch(() => setResolved([]));
  }, [wf.id, wf.revision, wf.projectId, node.id]);
  const upd = (i: number, p: Partial<CodeRef>) => draftState.set(node, 'codeRefs', refs.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <div className="form">
      <p className="muted small">
        Explicit, repository-relative mappings from this node to code. NodePilot does not infer architecture from source.
        {wf.projectId ? '' : ' Set a project for this workflow (Connections → Projects) to enable "Open in VS Code".'}
      </p>
      {refs.map((r, i) => {
        const res = resolved.find((x) => x.ref.id === r.id);
        return (
          <div className="card" key={r.id}>
            <div className="grid2">
              <Field label="Path"><input className="input mono" value={r.path} onChange={(e) => upd(i, { path: e.target.value })} placeholder="src/workers/scene.ts" /></Field>
              <Field label="Symbol"><input className="input mono" value={r.symbol ?? ''} onChange={(e) => upd(i, { symbol: e.target.value || undefined })} /></Field>
              <Field label="Line"><NumberInput value={r.line ?? 0} min={0} max={1_000_000} onChange={(v) => upd(i, { line: v || undefined })} /></Field>
              <Field label="Note"><input className="input" value={r.note ?? ''} onChange={(e) => upd(i, { note: e.target.value || undefined })} /></Field>
            </div>
            <div className="row">
              {res?.vscodeUrl ? <a className="btn small" href={res.vscodeUrl}>Open in VS Code</a> : <span className="muted small">{res?.error ?? (res && !res.exists ? 'File not found in project' : 'Save to resolve')}</span>}
              {res?.absolutePath && <button className="btn ghost small" onClick={() => void navigator.clipboard?.writeText(res.absolutePath!).then(() => useStore.getState().toast('info', 'Path copied'))}>Copy path</button>}
              <span className="grow" />
              <button className="btn ghost small" onClick={() => draftState.set(node, 'codeRefs', refs.filter((_, k) => k !== i))}>Remove</button>
            </div>
          </div>
        );
      })}
      <button className="btn ghost small" onClick={() => draftState.set(node, 'codeRefs', [...refs, { id: newId('ref'), path: '' }])}>＋ Code reference</button>
    </div>
  );
}

// ---------------------------------------------------------------- history & events

interface HistoryRow { runId: string; revision: number; runStatus: string; createdAt: string; node: { status: string; durationMs?: number; attempts: number; error?: { message: string }; demo?: boolean; usage?: { inputTokens?: number; outputTokens?: number } } }

function History({ node }: { node: WorkflowNode }) {
  const wf = useStore((s) => s.wf)!;
  const runs = useStore((s) => s.runs);
  const viewRun = useStore((s) => s.viewRun);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  useEffect(() => {
    void api.get<HistoryRow[]>(`/api/workflows/${enc(wf.id)}/nodes/${enc(node.id)}/history`).then(setRows);
  }, [wf.id, node.id, runs]);
  if (!rows.length) return <p className="muted">No local runs include this node yet.</p>;
  return (
    <table className="tbl">
      <thead><tr><th>When</th><th>Rev</th><th>Status</th><th>Duration</th><th>Tries</th><th>Usage</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.runId} className="clickable" onClick={() => void viewRun(r.runId)} title={r.node.error?.message ?? 'View this run on the canvas'}>
            <td>{fmtAgo(r.createdAt)}</td>
            <td className="mono">r{r.revision}</td>
            <td><StatusChip status={r.node.status} small /> {r.node.demo && <span className="badge tone-info">demo</span>}</td>
            <td className="mono">{fmtMs(r.node.durationMs)}</td>
            <td>{r.node.attempts}</td>
            <td className="mono small">{r.node.usage ? `${r.node.usage.inputTokens ?? '?'} in / ${r.node.usage.outputTokens ?? '?'} out` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NodeEvents({ node }: { node: WorkflowNode }) {
  const runDetail = useStore((s) => s.runDetail);
  const runEvents = useStore((s) => s.runEvents);
  const externalRuns = useStore((s) => s.externalRuns);
  const issues = (useStore((s) => s.validation)?.issues ?? []).filter((i) => i.nodeId === node.id);
  const st = runDetail?.nodes[node.id];
  const ext = externalRuns.flatMap((r) => (r.nodes[node.id] ? [{ run: r, st: r.nodes[node.id] }] : [])).slice(0, 10);
  return (
    <div className="form">
      {st?.error && (
        <div className="banner fail" role="alert">
          <b>{st.status === 'skipped' ? 'Skipped' : 'Error'}</b> {st.error.code && <span className="mono small">[{st.error.code}]</span>} {st.error.message}
          {st.error.upstream && <button className="btn ghost xs" onClick={() => useStore.getState().select(st.error!.upstream!)}>Go to upstream</button>}
          <button className="btn ghost xs" onClick={() => useStore.getState().set({ dialog: 'ask', askTarget: { nodeId: node.id } })}>Ask Claude to investigate</button>
        </div>
      )}
      {issues.length > 0 && <ul className="issues">{issues.map((i, k) => <li key={k} className={`issue lvl-${i.level}`}>{i.message}</li>)}</ul>}
      <h4>Events in selected local run</h4>
      <ul className="events">
        {runEvents.filter((e) => e.nodeId === node.id).map((e) => (
          <li key={e.seq}><span className="mono small muted">{fmtTime(e.at)}</span> <span className="mono">{e.type}</span> {e.message}</li>
        ))}
        {!runEvents.some((e) => e.nodeId === node.id) && <li className="muted">None</li>}
      </ul>
      <h4>External telemetry (observed, not executed here)</h4>
      <ul className="events">
        {ext.map(({ run, st: s }) => (
          <li key={run.serviceId + run.runId}>
            <span className="mono small muted">{fmtAgo(s.ts)}</span> <StatusChip status={s.status} small /> <span className="mono small">{run.runId}</span> {s.durationMs !== undefined && <span className="mono small">{fmtMs(s.durationMs)}</span>} {s.error?.message}
            {s.evaluation && <StatusChip status={s.evaluation.status === 'evaluation_passed' ? 'ok' : 'failing'} title="Functional evaluation" small />}
          </li>
        ))}
        {!ext.length && <li className="muted">No telemetry for this node</li>}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- workflow & edge

function WorkflowOverview() {
  const wf = useStore((s) => s.wf)!;
  const proposals = useStore((s) => s.proposals);
  const patch = useStore((s) => s.patch);
  const [name, setName] = useState(wf.name);
  const [desc, setDesc] = useState(wf.description);
  useEffect(() => { setName(wf.name); setDesc(wf.description); }, [wf.name, wf.description]);
  const [projects, setProjects] = useState<{ id: string; name: string; rootPath: string }[]>([]);
  useEffect(() => { void api.get<typeof projects>('/api/projects').then(setProjects); }, []);
  const open = proposals.filter((p) => p.status === 'open');
  const resolve = async (id: string, action: 'apply' | 'reject') => {
    try {
      await api.post(`/api/workflows/${enc(wf.id)}/proposals/${enc(id)}/${action}`);
      await useStore.getState().refresh();
    } catch (e) {
      useStore.getState().toast('error', (e as Error).message);
    }
  };
  return (
    <div className="tab-body">
      <div className="insp-title">Workflow</div>
      <p className="muted small">Select a node or connection to inspect it.</p>
      {wf.isExample && <div className="banner info">Illustrative example — not derived from your repository.</div>}
      <div className="form">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><textarea className="input" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <Field label="Project (for code references)">
          <select className="input" value={wf.projectId ?? ''} onChange={(e) => void patch([{ op: 'update_workflow', projectId: e.target.value || null }], 'set project')}>
            <option value="">— none —</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.rootPath})</option>)}
          </select>
        </Field>
        <button className="btn small" disabled={name === wf.name && desc === wf.description} onClick={() => void patch([{ op: 'update_workflow', name, description: desc }], 'rename workflow')}>Save details</button>
        <div className="kv">
          <span>Nodes</span><span>{wf.nodes.length}</span>
          <span>Connections</span><span>{wf.edges.length}</span>
          <span>Revision</span><span className="mono">r{wf.revision}</span>
          <span>Updated</span><span>{fmtAgo(wf.updatedAt)}</span>
        </div>
        <div className="row">
          <a className="btn ghost small" href={`/api/workflows/${enc(wf.id)}/export`} download>Export JSON</a>
          <FileLink />
        </div>
      </div>
      <h4>Proposals from Claude Code {open.length > 0 && <span className="badge tone-warn">{open.length} open</span>}</h4>
      {proposals.length === 0 && <p className="muted small">When Claude Code calls propose_workflow_patch, the proposal appears here for review.</p>}
      <ul className="events">
        {proposals.slice(0, 10).map((p) => (
          <li key={p.id} className="card">
            <div><b>{p.title}</b> <span className="muted small">by {p.actor} on r{p.baseRevision} · {fmtAgo(p.createdAt)}</span> <span className="badge">{p.status}</span></div>
            <div className="mono small">{p.summary}</div>
            {p.validation.issues.length > 0 && <div className="small muted">{p.validation.issues.length} validation note(s)</div>}
            {p.status === 'open' && (
              <div className="row">
                <button className="btn small primary" onClick={() => void resolve(p.id, 'apply')}>Apply</button>
                <button className="btn ghost small" onClick={() => void resolve(p.id, 'reject')}>Reject</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FileLink() {
  const wf = useStore((s) => s.wf)!;
  const [link, setLink] = useState<{ relPath: string; lastError: string | null } | null>(null);
  const [rel, setRel] = useState(`nodepilot/${wf.id}.json`);
  const load = () => void api.get<typeof link>(`/api/workflows/${enc(wf.id)}/file`).then(setLink);
  useEffect(load, [wf.id, wf.revision]);
  if (!wf.projectId) return null;
  if (link) {
    return (
      <span className="small">
        ⇄ Synced with <span className="mono">{link.relPath}</span> {link.lastError && <span className="tone-fail">({link.lastError})</span>}{' '}
        <button className="btn ghost xs" onClick={() => void api.post(`/api/workflows/${enc(wf.id)}/file/rewrite`).then(load)}>Rewrite file</button>
        <button className="btn ghost xs" onClick={() => void api.del(`/api/workflows/${enc(wf.id)}/file`).then(load)}>Unlink</button>
      </span>
    );
  }
  return (
    <span className="row small">
      <input className="input xs mono" value={rel} onChange={(e) => setRel(e.target.value)} aria-label="Workflow file path" />
      <button className="btn ghost xs" onClick={() => void api.put(`/api/workflows/${enc(wf.id)}/file`, { projectId: wf.projectId, relPath: rel }).then(load).catch((e) => useStore.getState().toast('error', e.message))}>Link file</button>
    </span>
  );
}

function EdgeInspector({ edgeId }: { edgeId: string }) {
  const wf = useStore((s) => s.wf)!;
  const patch = useStore((s) => s.patch);
  const e = wf.edges.find((x) => x.id === edgeId);
  if (!e) return <p className="muted pad">Connection not found.</p>;
  const s = wf.nodes.find((n) => n.id === e.source)!;
  const t = wf.nodes.find((n) => n.id === e.target)!;
  const sp = s.outputs.find((p) => p.id === e.sourcePort);
  const tp = t.inputs.find((p) => p.id === e.targetPort);
  return (
    <div className="tab-body">
      <div className="insp-title">Connection</div>
      <div className="kv">
        <span>From</span><span><button className="link" onClick={() => useStore.getState().select(s.id)}>{s.label}</button>.<span className="mono">{e.sourcePort}</span> <span className={`pt t-${sp?.type}`}>{sp?.type}</span></span>
        <span>To</span><span><button className="link" onClick={() => useStore.getState().select(t.id)}>{t.label}</button>.<span className="mono">{e.targetPort}</span> <span className={`pt t-${tp?.type}`}>{tp?.type}</span></span>
        <span>Merge</span><span>{tp?.multiple ? `fan-in (${tp.merge})` : 'single value'}</span>
        <span>Id</span><span className="mono">{e.id}</span>
      </div>
      <button className="btn danger small" onClick={() => void patch([{ op: 'remove_edge', edgeId: e.id }], 'delete connection')}>Delete connection</button>
    </div>
  );
}

// ---------------------------------------------------------------- small helpers

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {help && <span className="field-help">{help}</span>}
    </label>
  );
}

function NumberInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      className="input mono"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (Number.isInteger(v) && v >= min && v <= max) onChange(v);
      }}
      aria-invalid={!(Number.isInteger(Number(text)) && Number(text) >= min && Number(text) <= max)}
    />
  );
}

function JsonField({ label, help, value, schema, field, onValid }: { label: string; help?: string; value: unknown; schema: z.ZodType; field: string; onValid: (v: unknown) => void }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [err, setErr] = useState<string | null>(null);
  const ext = stableStringify(value);
  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
    setErr(null);
    draftState.setInvalid(field, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ext]);
  return (
    <Field label={label} help={help}>
      <textarea
        className={`input mono${err ? ' invalid' : ''}`}
        rows={Math.min(12, Math.max(3, text.split('\n').length))}
        value={text}
        spellCheck={false}
        aria-invalid={!!err}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = schema.safeParse(JSON.parse(e.target.value));
            if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
            setErr(null);
            draftState.setInvalid(field, null);
            onValid(parsed.data);
          } catch (x) {
            setErr((x as Error).message);
            draftState.setInvalid(field, (x as Error).message);
          }
        }}
      />
      {err && <span className="field-err">{err}</span>}
    </Field>
  );
}

function Pre({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="pre" open>
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
