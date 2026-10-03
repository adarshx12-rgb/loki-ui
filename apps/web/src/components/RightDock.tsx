import { useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { safeStorage, useStore } from '../store';
import { HistoryView } from './HistoryPanel';

export interface DockSection {
  id: string;
  label: string;
  icon: string;
  /** Keyboard shortcut shown in the tooltip (wired in App's useShortcuts). */
  shortcut?: string;
  render: () => ReactNode;
}

/** Sections of the right-hand dock. Add new ones here; each gets an icon on the rail. */
export const DOCK_SECTIONS: DockSection[] = [
  { id: 'history', label: 'History', icon: '⟲', shortcut: 'Shift+H', render: () => <HistoryView /> },
];

const MIN_W = 280;
const MAX_W = 640;

/**
 * Collapsible right-hand dock: an always-visible icon rail; clicking an icon opens
 * that section, clicking it again (or ») collapses the dock. Drag the left edge to resize.
 */
export function RightDock() {
  const tab = useStore((s) => s.rightTab);
  const toggleRight = useStore((s) => s.toggleRight);
  const set = useStore((s) => s.set);
  const [width, setWidth] = useState(() => clampW(Number(safeStorage.get('np.dock.width')) || 360));
  const drag = useRef<{ x: number; w: number } | null>(null);
  const section = DOCK_SECTIONS.find((d) => d.id === tab);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(clampW(drag.current.w + drag.current.x - e.clientX));
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    safeStorage.set('np.dock.width', String(width));
  };

  return (
    <aside className={`dock${section ? ' open' : ''}`} aria-label="Side panel">
      {section && (
        <div className="dock-panel" style={{ width }}>
          <div
            className="dock-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize side panel"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onDoubleClick={() => { setWidth(360); safeStorage.set('np.dock.width', '360'); }}
          />
          <div className="dock-head">
            <span className="floating-icon" aria-hidden="true">{section.icon}</span>
            <span className="floating-title">{section.label}</span>
            <span className="grow" />
            <button className="btn ghost xs" onClick={() => set({ rightTab: null })} title="Collapse panel" aria-label="Collapse panel">»</button>
          </div>
          <div className="dock-body">{section.render()}</div>
        </div>
      )}
      <nav className="dock-rail" aria-label="Side panel sections">
        {DOCK_SECTIONS.map((d) => (
          <button
            key={d.id}
            className={`dock-tab${tab === d.id ? ' on' : ''}`}
            onClick={() => toggleRight(d.id)}
            aria-pressed={tab === d.id}
            title={`${d.label}${d.shortcut ? ` (${d.shortcut})` : ''}`}
          >
            <span className="dock-tab-icon" aria-hidden="true">{d.icon}</span>
            <span className="dock-tab-label">{d.label}</span>
          </button>
        ))}
        <span className="grow" />
        {section && <button className="dock-tab" onClick={() => set({ rightTab: null })} title="Collapse panel" aria-label="Collapse panel"><span className="dock-tab-icon">»</span></button>}
      </nav>
    </aside>
  );
}

function clampW(w: number) {
  return Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
}
