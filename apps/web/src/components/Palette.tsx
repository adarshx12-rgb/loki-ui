import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_TEMPLATES, newId } from '@nodepilot/shared';
import { useStore } from '../store';
import { KIND_ICON } from '../status';

export function Palette() {
  const [q, setQ] = useState('');
  const patch = useStore((s) => s.patch);
  const select = useStore((s) => s.select);
  const wf = useStore((s) => s.wf);
  const rf = useReactFlow();
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    return NODE_TEMPLATES.filter((x) => !t || `${x.label} ${x.kind} ${x.description}`.toLowerCase().includes(t));
  }, [q]);

  const add = async (key: string) => {
    const tpl = NODE_TEMPLATES.find((t) => t.key === key)!;
    const el = document.querySelector('.canvas');
    const rect = el?.getBoundingClientRect();
    const center = rect ? rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
    const id = newId('n');
    // Start at the visible centre and step down until the card does not overlap an existing one.
    const pos = { x: Math.round(center.x - 115), y: Math.round(center.y - 50) };
    const overlaps = () => (wf?.nodes ?? []).some((n) => Math.abs(n.position.x - pos.x) < 240 && Math.abs(n.position.y - pos.y) < 130);
    for (let i = 0; i < 40 && overlaps(); i++) pos.y += 140;
    if (await patch([{ op: 'add_node', node: tpl.build(id, pos) }], `add ${tpl.label}`)) select(id);
  };

  return (
    <aside className="palette" aria-label="Node palette">
      <div className="panel-title">Nodes</div>
      <input
        id="palette-search"
        className="input"
        type="search"
        placeholder="Search nodes…  (Ctrl+K)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && items[0]) void add(items[0].key);
        }}
        aria-label="Search node types"
      />
      <ul className="palette-list" role="list">
        {items.map((t) => (
          <li key={t.key}>
            <button
              className="palette-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-nodepilot-template', t.key);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => void add(t.key)}
              title={`${t.description}\nClick to add at the centre, or drag onto the canvas.`}
            >
              <span className="np-kind" aria-hidden="true">{KIND_ICON[t.kind]}</span>
              <span className="palette-text">
                <span className="palette-label">{t.label}</span>
                <span className="palette-desc">{t.description}</span>
              </span>
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="muted pad">No matches</li>}
      </ul>
    </aside>
  );
}
