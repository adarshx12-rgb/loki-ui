import { useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_TEMPLATES, newId } from '@nodepilot/shared';
import { useStore } from '../store';
import { KIND_ICON } from '../status';
import { SHAPE_OF } from './shapes';

const GROUP_ORDER = ['General', 'Layout', 'AI pipeline'] as const;
const KEY_ORDER = ['user_query', 'results', 'empty', 'model', 'instruction', 'router', 'datastore', 'api_service', 'auxiliary'];
const rank = (key: string) => (KEY_ORDER.indexOf(key) + 1 || 99);

/** ComfyUI-style "add node" search box, opened by double-clicking the canvas (or Ctrl+K). */
export function NodeSearch() {
  const at = useStore((s) => s.nodeSearch);
  const patch = useStore((s) => s.patch);
  const select = useStore((s) => s.select);
  const set = useStore((s) => s.set);
  const rf = useReactFlow();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Generic building blocks first; AI-pipeline presets are examples, not assumptions about your project.
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    return NODE_TEMPLATES
      .filter((x) => !t || `${x.label} ${x.kind} ${x.description} ${x.group}`.toLowerCase().includes(t))
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || rank(a.key) - rank(b.key));
  }, [q]);

  useEffect(() => {
    setQ('');
    setActive(0);
    input.current?.focus();
  }, [at]);
  useEffect(() => setActive(0), [q]);

  if (!at) return null;
  const close = () => set({ nodeSearch: null });
  const add = async (key: string) => {
    const tpl = NODE_TEMPLATES.find((t) => t.key === key)!;
    const pos = rf.screenToFlowPosition(at);
    const id = newId('n');
    close();
    if (await patch([{ op: 'add_node', node: tpl.build(id, { x: Math.round(pos.x), y: Math.round(pos.y) }) }], `add ${tpl.label}`)) select(id);
  };

  const left = Math.min(at.x, window.innerWidth - 330);
  const top = Math.min(at.y, window.innerHeight - 380);
  return (
    <>
      <div className="search-backdrop" onMouseDown={close} />
      <div className="node-search" style={{ left, top }} role="dialog" aria-label="Add node">
        <input
          ref={input}
          className="input"
          type="search"
          placeholder="Search nodes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); close(); }
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter' && items[active]) void add(items[active].key);
          }}
          aria-label="Search node types"
          aria-activedescendant={items[active] ? `ns-${items[active].key}` : undefined}
        />
        <ul className="node-search-list" role="listbox">
          {items.map((t, i) => (
            <li key={t.key} id={`ns-${t.key}`} role="option" aria-selected={i === active} className={i > 0 && items[i - 1].group !== t.group ? 'ns-break' : undefined} data-group={i === 0 || items[i - 1].group !== t.group ? t.group : undefined}>
              <button className={`ns-item${i === active ? ' on' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => void add(t.key)}>
                <span className={`ns-shape shape-${SHAPE_OF[t.kind]}`} aria-hidden="true">{KIND_ICON[t.kind]}</span>
                <span className="ns-text">
                  <span className="ns-label">{t.label}</span>
                  <span className="ns-desc">{t.description}</span>
                </span>
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="muted pad small">No matches</li>}
        </ul>
      </div>
    </>
  );
}
