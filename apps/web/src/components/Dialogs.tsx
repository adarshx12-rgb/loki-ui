import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Modal } from './Modal';

export function NewWorkflow() {
  const s = useStore();
  const [name, setName] = useState('');
  const [importText, setImportText] = useState('');
  const create = async () => {
    try {
      const wf = await api.post<{ id: string }>('/api/workflows', { name: name.trim() });
      await s.loadWorkflows();
      await s.loadWorkflow(wf.id);
      s.set({ dialog: null });
    } catch (e) {
      s.toast('error', (e as Error).message);
    }
  };
  const doImport = async () => {
    try {
      const wf = await api.post<{ id: string }>('/api/workflows/import', JSON.parse(importText));
      await s.loadWorkflows();
      await s.loadWorkflow(wf.id);
      s.set({ dialog: null });
    } catch (e) {
      s.toast('error', (e as Error).message);
    }
  };
  return (
    <Modal title="New workflow" onClose={() => s.set({ dialog: null })}>
      <div className="form">
        <label className="field"><span className="field-label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} /></label>
        <div className="row"><span className="grow" /><button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>Create empty workflow</button></div>
        <details>
          <summary>Import from exported JSON</summary>
          <textarea className="input mono" rows={8} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"schemaVersion":1,...}' />
          <button className="btn" disabled={!importText.trim()} onClick={() => void doImport()}>Import</button>
        </details>
      </div>
    </Modal>
  );
}

export function ValidateDialog() {
  const s = useStore();
  const issues = s.validation?.issues ?? [];
  const groups: [string, string][] = [['save', 'Structural (blocks saving)'], ['run', 'Blocks running'], ['warning', 'Warnings']];
  return (
    <Modal title="Validation" onClose={() => s.set({ dialog: null })}>
      {issues.length === 0 && <p>✓ No issues. The workflow is acyclic, ports are compatible, required inputs are connected and every node is executable or explicitly observed.</p>}
      {groups.map(([lvl, label]) => {
        const list = issues.filter((i) => i.level === lvl);
        if (!list.length) return null;
        return (
          <div key={lvl}>
            <h4>{label}</h4>
            <ul className="issues">
              {list.map((i, k) => (
                <li key={k} className={`issue lvl-${i.level}`}>
                  <span aria-hidden="true">{lvl === 'warning' ? '△' : '⚠'}</span> {i.message}{' '}
                  {i.nodeId && <button className="link" onClick={() => { s.select(i.nodeId!); s.set({ dialog: null }); }}>Show node</button>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </Modal>
  );
}

export function HelpDialog() {
  const set = useStore((s) => s.set);
  const rows: [string, string][] = [
    ['Ctrl/⌘ + S', 'Save inspector changes'],
    ['Ctrl/⌘ + Z', 'Undo your last edit'],
    ['Ctrl/⌘ + Shift + Z, Ctrl + Y', 'Redo'],
    ['Ctrl/⌘ + Enter', 'Run workflow'],
    ['Ctrl/⌘ + K', 'Search the node palette'],
    ['F', 'Fit view'],
    ['Delete / Backspace', 'Delete selected node or connection'],
    ['Esc', 'Clear selection / close dialog'],
    ['Tab', 'Move focus between nodes, edges and panels'],
    ['?', 'This help'],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={() => set({ dialog: null })}>
      <table className="tbl"><tbody>{rows.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody></table>
      <p className="muted small">Animations respect your system's reduced-motion setting. Edge highlighting reflects only the selected path or recorded execution events.</p>
    </Modal>
  );
}

export function ConflictBanner() {
  const s = useStore();
  const c = s.conflict;
  if (!c) return null;
  return (
    <div className="banner warn conflict" role="alert">
      <div className="grow">
        <b>Not saved — revision conflict.</b> {c.message}
        {c.details?.changesSince?.length ? (
          <ul className="small">{c.details.changesSince.slice(-5).map((x) => <li key={x.id}>r{x.toRevision} · {x.actor === 'mcp' ? 'Claude Code (MCP)' : x.actor}: {x.summary}</li>)}</ul>
        ) : null}
      </div>
      <button className="btn small" onClick={() => void s.refresh().then(() => s.set({ conflict: null }))}>Reload latest (discard my change)</button>
      {c.retry && <button className="btn small primary" onClick={() => { const r = c.retry!; s.set({ conflict: null }); void r(); }}>Re-apply my change on latest</button>}
      <button className="btn ghost small" onClick={() => s.set({ conflict: null })} aria-label="Dismiss">✕</button>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span aria-hidden="true">{t.kind === 'error' ? '✕' : t.kind === 'success' ? '✓' : 'ℹ'}</span> {t.text}
          <button className="btn ghost xs" onClick={() => dismiss(t.id)} aria-label="Dismiss">✕</button>
        </div>
      ))}
    </div>
  );
}

export function PairingScreen() {
  const s = useStore();
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    try {
      await api.post('/api/auth/pair', { code });
      await s.init();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <main className="pairing">
      <div className="pair-card">
        <div className="brand big"><span className="logo" aria-hidden="true">◈</span> {s.appName}</div>
        <p>Enter the pairing code printed in the terminal where the {s.appName} server is running.</p>
        <input className="input mono big" autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && void submit()} placeholder="XXXX-XXXX" aria-label="Pairing code" />
        {err && <p className="tone-fail" role="alert">{err}</p>}
        <button className="btn primary" disabled={code.length < 8} onClick={() => void submit()}>Pair this browser</button>
        <p className="muted small">Need a new code? Run <span className="mono">npm run pair</span>. Pairing stores an HttpOnly session cookie for this browser only; even on localhost, every API call requires it.</p>
      </div>
    </main>
  );
}
