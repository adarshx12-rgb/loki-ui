import type { ReactNode } from 'react';
import type { WorkflowNode } from '@nodepilot/shared';
import { useStore } from '../store';
import { DOT, type Dot } from '../status';

export interface FooterCtx {
  node: WorkflowNode;
  dot: Dot;
  /** Extra status text (error message, issues…). */
  detail?: string;
}

/** Sticky note, drawn inline so it stays sharp at any zoom. */
export function NoteIcon({ filled }: { filled: boolean }) {
  return (
    <svg className={`np-note-icon${filled ? '' : ' empty'}`} viewBox="0 0 28 28" aria-hidden="true">
      <g transform="rotate(-4 14 15)">
        <rect x="4.5" y="7" width="19" height="18" rx="1.8" fill="#ffd94a" stroke="#fff" strokeWidth="1.7" />
        <path d="M8 12.2h12M8 15.7h12M8 19.2h12M8 22.4h7" stroke="#8a5a6a" strokeWidth="0.9" strokeLinecap="round" opacity=".7" />
      </g>
      <rect x="1.4" y="3.2" width="10.4" height="4.8" rx="0.9" transform="rotate(-32 6.6 5.6)" fill="#ff6b57" fillOpacity=".92" stroke="#fff" strokeWidth="1" />
    </svg>
  );
}

function NoteButton({ node }: FooterCtx) {
  const has = node.notes.trim().length > 0;
  const open = () => {
    const s = useStore.getState();
    s.select(node.id);
    s.set({ inspectorTab: 'notes' });
    s.togglePanel('inspector', true);
  };
  return (
    <button
      className="np-fbtn nodrag nopan"
      onClick={open}
      title={has ? node.notes.trim().replace(/\s+/g, ' ').slice(0, 160) : 'Add a note'}
      aria-label={has ? `Open note for ${node.label}` : `Add a note to ${node.label}`}
    >
      <NoteIcon filled={has} />
    </button>
  );
}

function ActivityStatus({ dot, detail }: FooterCtx) {
  const d = DOT[dot];
  return (
    <span className="np-fstatus" title={`${d.label} — ${detail ?? d.hint}`}>
      <span className={`dot dot-${dot}`} role="img" aria-label={`Status: ${d.label}`} />
      <span>{d.label}</span>
    </span>
  );
}

/**
 * Icons along the bottom of a node. Add a new entry here to give every box another icon;
 * `render` receives the node and its current activity state.
 */
export const FOOTER_ITEMS: { id: string; render: (c: FooterCtx) => ReactNode }[] = [
  { id: 'note', render: (c) => <NoteButton {...c} /> },
  { id: 'status', render: (c) => <ActivityStatus {...c} /> },
];

export function NodeFooter(ctx: FooterCtx) {
  return (
    <div className="np-footer">
      {FOOTER_ITEMS.map((i) => <span key={i.id} className="np-fitem">{i.render(ctx)}</span>)}
    </div>
  );
}
