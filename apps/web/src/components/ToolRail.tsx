import type { ReactNode } from 'react';
import { useStore, type Tool } from '../store';

const svg = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

export const TOOLS: { id: Tool; label: string; key: string; hint: string; icon: ReactNode }[] = [
  {
    id: 'select', label: 'Select', key: 'V',
    hint: 'Click to select · drag boxes · Delete removes · double-click to edit or add',
    icon: svg(<path d="M5 3l14 7-6 2-2 6z" />),
  },
  {
    id: 'marquee', label: 'Rectangle select', key: 'R',
    hint: 'Drag on the grid to select several boxes',
    icon: svg(<><rect x="4" y="4" width="16" height="16" rx="1.5" strokeDasharray="3 3" /><path d="M14 14l6 6" /></>),
  },
  {
    id: 'hand', label: 'Hand', key: 'H',
    hint: 'Drag to move around the canvas (or hold Space with any tool)',
    icon: svg(<path d="M8 13V5.5a1.5 1.5 0 013 0V12m0-1.5v-6a1.5 1.5 0 013 0V12m0-5.5a1.5 1.5 0 013 0V14a6 6 0 01-6 6h-1.2a6 6 0 01-4.6-2.2L4.3 14.4a1.5 1.5 0 012.3-1.9L8 14" />),
  },
  {
    id: 'node', label: 'Node tool', key: 'N',
    hint: 'Click the grid to add a node · drag between ports to connect · click a connection to remove it',
    icon: <span className="tool-glyph" aria-hidden="true">↗</span>,
  },
];

/** Slim vertical tool strip on the left edge of the canvas. */
export function ToolRail() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  return (
    <div className="tool-rail" role="toolbar" aria-label="Canvas tools" aria-orientation="vertical">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`tool-btn${tool === t.id ? ' on' : ''}`}
          aria-pressed={tool === t.id}
          aria-label={`${t.label} (${t.key})`}
          onClick={() => setTool(t.id)}
        >
          {t.icon}
          <span className="tool-tip" role="tooltip"><span className="tool-tip-head"><b>{t.label}</b><kbd>{t.key}</kbd></span><span className="tool-tip-hint">{t.hint}</span></span>
        </button>
      ))}
    </div>
  );
}
