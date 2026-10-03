import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';

const Chevron = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
);
const Trash = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16M9 7V4.5h6V7M6.5 7l.9 12.5h9.2L17.5 7M10 11v5.5M14 11v5.5" />
  </svg>
);

/** Project dropdown: pick a workflow, or trash one (with confirmation). Replaces the native select so rows can hold a delete button. */
export function WorkflowPicker() {
  const workflows = useStore((s) => s.workflows);
  const wf = useStore((s) => s.wf);
  const loadWorkflow = useStore((s) => s.loadWorkflow);
  const set = useStore((s) => s.set);
  const simulating = useStore((s) => !!s.sim);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...(root.current?.querySelectorAll<HTMLElement>('.wfp-item') ?? [])];
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return workflows.filter((w) => !t || w.name.toLowerCase().includes(t));
  }, [workflows, q]);

  return (
    <div className="wfp" ref={root}>
      <button ref={trigger} className="input wfp-trigger" aria-haspopup="true" aria-expanded={open} onClick={() => { setOpen(!open); setQ(''); }} disabled={simulating} title={simulating ? 'Stop the simulation to switch projects' : 'Switch project'}>
        <span className="wfp-name">{wf ? `${wf.name}${wf.isExample ? ' (example)' : ''}` : 'No project'}</span>
        <Chevron />
      </button>
      {open && (
        <div className="wfp-pop" role="group" aria-label="Projects">
          {workflows.length > 6 && <input className="input xs wfp-search" type="search" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" autoFocus />}
          <ul className="wfp-list">
            {shown.map((w) => (
              <li key={w.id} className={`wfp-row${w.id === wf?.id ? ' current' : ''}`}>
                <button className="wfp-item" onClick={() => { setOpen(false); void loadWorkflow(w.id); }} aria-current={w.id === wf?.id}>
                  <span className="wfp-item-name">{w.name}</span>
                  <span className="wfp-item-meta muted xs">{w.isExample ? 'example · ' : ''}{w.nodeCount} nodes{w.projectId ? ' · imported' : ''}</span>
                </button>
                {/* The built-in example is re-created on every start, so it has nothing to delete. */}
                {!w.isExample && (
                  <button
                    className="wfp-trash"
                    title={`Delete “${w.name}”`}
                    aria-label={`Delete project ${w.name}`}
                    onClick={() => { setOpen(false); set({ dialog: 'deleteWorkflow', deleteTarget: { id: w.id, name: w.name, imported: !!w.projectId } }); }}
                  >
                    <Trash />
                  </button>
                )}
              </li>
            ))}
            {shown.length === 0 && <li className="muted pad small">{workflows.length ? 'No matches' : 'No projects yet. Use New or Import project.'}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
