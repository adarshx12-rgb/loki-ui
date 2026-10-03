import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { safeStorage } from '../store';

interface Pos { x: number; y: number }

/**
 * A window floating over the canvas: drag it by its title bar, collapse it to the
 * title bar, close it. Position and collapsed state are remembered per panel.
 */
export function FloatingPanel({
  id, title, icon, children, width, height, initial, onClose, actions,
}: {
  id: string;
  title: ReactNode;
  icon?: string;
  children: ReactNode;
  width: number;
  height: number;
  /** Default placement, computed from the viewport the first time. */
  initial: (vw: number, vh: number) => Pos;
  onClose: () => void;
  actions?: ReactNode;
}) {
  const [pos, setPos] = useState<Pos>(() => {
    try {
      const saved = JSON.parse(safeStorage.get(`np.panel.${id}`) ?? 'null') as Pos | null;
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return clamp(saved, width);
    } catch { /* ignore */ }
    return clamp(initial(window.innerWidth, window.innerHeight), width);
  });
  const [collapsed, setCollapsed] = useState(() => safeStorage.get(`np.panel.${id}.collapsed`) === '1');
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p, width));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [width]);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, select')) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setPos(clamp({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }, width));
  };
  const onUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setPos((p) => {
      safeStorage.set(`np.panel.${id}`, JSON.stringify(p));
      return p;
    });
  }, [id]);

  const toggle = () => {
    safeStorage.set(`np.panel.${id}.collapsed`, collapsed ? '0' : '1');
    setCollapsed(!collapsed);
  };

  const maxH = Math.max(160, window.innerHeight - pos.y - 12);
  return (
    <section
      className={`floating${collapsed ? ' collapsed' : ''}`}
      style={{ left: pos.x, top: pos.y, width, height: collapsed ? undefined : Math.min(height, maxH) }}
      aria-label={typeof title === 'string' ? title : id}
    >
      <div className="floating-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={toggle}>
        {icon && <span className="floating-icon" aria-hidden="true">{icon}</span>}
        <span className="floating-title">{title}</span>
        <span className="grow" />
        {actions}
        <button className="btn ghost xs" onClick={toggle} aria-expanded={!collapsed} title={collapsed ? 'Expand' : 'Collapse'} aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}>{collapsed ? '▸' : '▾'}</button>
        <button className="btn ghost xs" onClick={onClose} title="Close" aria-label="Close panel">✕</button>
      </div>
      {!collapsed && <div className="floating-body">{children}</div>}
    </section>
  );
}

function clamp(p: Pos, width: number): Pos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return { x: Math.round(Math.min(Math.max(8 - width + 120, p.x), vw - 120)), y: Math.round(Math.min(Math.max(48, p.y), vh - 40)) };
}
