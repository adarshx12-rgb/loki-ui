import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { draftState } from '../inspector/draft';
import { dependenciesOf, simChanges, withDependencies, type SimChange, type Verb } from '../sim';
import { api, enc } from '../api';
import { Modal } from './Modal';

const VERB_TONE: Record<Verb, string> = {
  Added: 'ok', Removed: 'fail', Edited: 'info', Moved: 'idle', Connected: 'ok', Disconnected: 'warn', Renamed: 'info',
};

/** Live list of what differs between the simulation and the project as it was when it started. */
function useSimChanges(): SimChange[] {
  const sim = useStore((s) => s.sim);
  const wf = useStore((s) => s.wf);
  return useMemo(() => (sim && wf && wf.id === sim.sandboxId ? simChanges(sim.base, wf) : []), [sim, wf]);
}

// ------------------------------------------------------------------ right-panel section

export function SimulationPanel() {
  const sim = useStore((s) => s.sim);
  const wf = useStore((s) => s.wf);
  const s = useStore.getState;
  const dirty = draftState.useDirty();
  const changes = useSimChanges();
  const run = useStore((st) => (st.overlay?.kind === 'local' ? st.runs.find((r) => r.id === (st.overlay as { runId: string }).runId) : undefined));
  const running = run && (run.status === 'running' || run.status === 'queued');

  if (!sim) {
    return (
      <div className="sim-panel">
        <h3 className="sim-h">Try changes safely</h3>
        <p className="muted small">
          A simulation is an alternate copy of <b>{wf?.name}</b>. Edit boxes, rewire connections, change settings and run it as often as you like.
          The real project doesn’t change.
        </p>
        <ol className="sim-steps small">
          <li>Start the simulation. The canvas turns green so you always know where you are.</li>
          <li>Change anything and press <b>Run</b> to test it.</li>
          <li>Press <b>Stop</b> to see every change, then apply the ones you want to the main project.</li>
        </ol>
        {dirty && <div className="banner warn small">Save or discard the inspector edit first.</div>}
        <button className="btn sim-start" disabled={!wf || dirty} onClick={() => void s().startSimulation()}>◉ Start simulation</button>
      </div>
    );
  }

  return (
    <div className="sim-panel">
      <div className="sim-live"><span className="sim-pulse" aria-hidden="true" /> Simulating <b>{sim.mainName}</b></div>
      <p className="muted small">Edits and runs here stay in the simulation until you apply them.</p>
      <div className="row">
        <button className="btn primary" disabled={!!running} onClick={() => void s().startRun()}>▶ Run simulation</button>
        <button className="btn danger" onClick={() => s().set({ dialog: 'simReview' })}>■ Stop &amp; review</button>
      </div>
      <h4>Changes so far · {changes.length}</h4>
      {changes.length === 0 ? (
        <p className="muted small">None yet. Anything you change shows up here.</p>
      ) : (
        <ul className="sim-mini">
          {changes.slice(0, 12).map((c) => (
            <li key={c.key}><span className={`chip chip-sm tone-${VERB_TONE[c.verb]}`}>{c.verb}</span> <span className="sim-mini-title">{c.title}</span></li>
          ))}
          {changes.length > 12 && <li className="muted small">…and {changes.length - 12} more</li>}
        </ul>
      )}
      {run && <p className="small">Last simulated run: <b className={`tone-${run.status === 'succeeded' ? 'ok' : run.status === 'failed' ? 'fail' : 'run'}`}>{run.status}</b> (details in History)</p>}
    </div>
  );
}

// ------------------------------------------------------------------ canvas overlay (banner, stop, matrix rain)

export function SimulationOverlay() {
  const sim = useStore((s) => s.sim);
  const changes = useSimChanges();
  const set = useStore((s) => s.set);
  if (!sim) return null;
  return (
    <>
      <MatrixRain />
      <div className="sim-vignette" aria-hidden="true" />
      <div className="sim-banner" role="status">
        <span className="sim-pulse" aria-hidden="true" />
        <span><b>SIMULATION</b> · {sim.mainName} stays untouched{changes.length ? ` · ${changes.length} change${changes.length > 1 ? 's' : ''}` : ''}</span>
        <button className="btn danger small sim-stop" onClick={() => set({ dialog: 'simReview' })} title="Stop and review the changes">■ Stop</button>
      </div>
    </>
  );
}

/** Faint falling glyphs behind the graph. Off for reduced motion. */
function MatrixRain() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const glyphs = '01アイウエオカキクケコサシスセソタチツテトナニヌネノ<>{}=+*';
    const size = 15;
    let drops: number[] = [];
    const resize = () => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      drops = Array.from({ length: Math.ceil(canvas.width / size) }, () => Math.random() * -50);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    let last = 0;
    let raf = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 70 || document.hidden) return;
      last = t;
      ctx.fillStyle = 'rgba(14, 20, 16, 0.14)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${size}px monospace`;
      for (let i = 0; i < drops.length; i++) {
        const y = drops[i] * size;
        ctx.fillStyle = Math.random() > 0.96 ? 'rgba(190, 255, 210, 0.9)' : 'rgba(70, 220, 120, 0.75)';
        ctx.fillText(glyphs[(Math.random() * glyphs.length) | 0], i * size, y);
        drops[i] = y > canvas.height && Math.random() > 0.975 ? 0 : drops[i] + 1;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return <canvas ref={ref} className="sim-rain" aria-hidden="true" />;
}

// ------------------------------------------------------------------ stop → review dialog

type RowState = { status: 'applying' } | { status: 'error'; message: string };

export function SimReviewDialog() {
  const sim = useStore((s) => s.sim);
  const s = useStore.getState;
  const changes = useSimChanges();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(changes.map((c) => c.key)));
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [applied, setApplied] = useState<string[]>([]);
  const [mainMoved, setMainMoved] = useState<number | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (!sim) return;
    void api.get<{ workflow: { revision: number } }>(`/api/workflows/${enc(sim.mainId)}`).then((r) => setMainMoved(r.workflow.revision !== sim.mainRevision ? r.workflow.revision : null)).catch(() => undefined);
  }, [sim]);

  if (!sim) return null;
  const close = () => s().set({ dialog: null });
  const visibleSelected = changes.filter((c) => selected.has(c.key));

  const apply = async (picked: SimChange[]) => {
    const group = withDependencies(changes, new Set(picked.map((c) => c.key)), sim.base);
    setRows((r) => ({ ...r, ...Object.fromEntries(group.map((c) => [c.key, { status: 'applying' as const }])) }));
    const err = await s().applySimChanges(group.map((c) => c.op), group.length === 1 ? `${group[0].verb} ${group[0].title}` : `${group.length} simulation changes`);
    if (err) {
      setRows((r) => ({ ...r, ...Object.fromEntries(group.map((c) => [c.key, { status: 'error' as const, message: err }])) }));
    } else {
      setRows((r) => { const n = { ...r }; for (const c of group) delete n[c.key]; return n; });
      setApplied((a) => [...a, ...group.map((c) => `${c.verb} ${c.title}`)]);
      setSelected((sel) => { const n = new Set(sel); for (const c of group) n.delete(c.key); return n; });
    }
  };

  const exit = async () => {
    setExiting(true);
    await s().exitSimulation();
    if (applied.length) s().toast('success', `Applied ${applied.length} change${applied.length > 1 ? 's' : ''} to “${sim.mainName}”.`);
  };

  return (
    <Modal title="Simulation changes" onClose={close} wide>
      <p className="muted small" style={{ margin: 0 }}>
        Everything you changed in the simulation of <b>{sim.mainName}</b>. Tick what should become real and press <b>Apply to main</b>.
        Anything you don’t apply is discarded when you exit.
      </p>
      {mainMoved !== null && (
        <div className="banner warn small">The main project was edited elsewhere since the simulation started (now r{mainMoved}). Applying an edit to a box that was also changed there replaces that box.</div>
      )}

      {changes.length > 0 && (
        <div className="row sim-review-tools">
          <label className="row small"><input type="checkbox" checked={visibleSelected.length === changes.length} ref={(el) => { if (el) el.indeterminate = visibleSelected.length > 0 && visibleSelected.length < changes.length; }} onChange={(e) => setSelected(e.target.checked ? new Set(changes.map((c) => c.key)) : new Set())} /> Select all</label>
          <button className="btn ghost small" onClick={() => setSelected(new Set(changes.filter((c) => !c.layoutOnly).map((c) => c.key)))}>Skip position-only moves</button>
          <span className="grow" />
          <button className="btn primary" disabled={!visibleSelected.length || Object.values(rows).some((r) => r.status === 'applying')} onClick={() => void apply(visibleSelected)}>⤴ Apply selected to main ({visibleSelected.length})</button>
        </div>
      )}

      <ul className="sim-list">
        {changes.map((c) => {
          const deps = dependenciesOf(changes, c, sim.base);
          const row = rows[c.key];
          return (
            <li key={c.key} className={`sim-row${row?.status === 'error' ? ' err' : ''}`}>
              <input type="checkbox" checked={selected.has(c.key)} aria-label={`Select: ${c.verb} ${c.title}`} onChange={(e) => setSelected((sel) => { const n = new Set(sel); if (e.target.checked) n.add(c.key); else n.delete(c.key); return n; })} />
              <span className={`chip chip-sm tone-${VERB_TONE[c.verb]} sim-verb`}>{c.verb}</span>
              <span className="sim-text">
                <span className="sim-title">{c.title}</span>
                {c.detail && <span className="sim-detail">{c.detail}</span>}
                {deps.length > 0 && <span className="sim-deps">Also applies: {deps.map((d) => `${d.verb.toLowerCase()} ${d.title}`).join('; ')}</span>}
                {row?.status === 'error' && <span className="sim-err">Couldn’t apply: {row.message}</span>}
              </span>
              <button className="btn small sim-apply" disabled={row?.status === 'applying'} onClick={() => void apply([c])} title="Make this change in the real project">
                {row?.status === 'applying' ? 'Applying…' : '⤴ Apply to main'}
              </button>
            </li>
          );
        })}
        {changes.length === 0 && <li className="muted pad small">{applied.length ? 'Every change has been applied.' : 'No changes were made in this simulation.'}</li>}
      </ul>

      {applied.length > 0 && (
        <details className="sim-applied" open>
          <summary>✓ Applied to main · {applied.length}</summary>
          <ul className="small">{applied.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </details>
      )}

      <div className="row">
        <button className="btn" onClick={close} disabled={exiting}>Keep simulating</button>
        <span className="grow" />
        <button className={`btn ${changes.length ? 'danger' : 'primary'}`} onClick={() => void exit()} disabled={exiting}>
          {exiting ? 'Exiting…' : changes.length ? `Discard ${changes.length} unapplied & exit` : 'Exit simulation'}
        </button>
      </div>
    </Modal>
  );
}
