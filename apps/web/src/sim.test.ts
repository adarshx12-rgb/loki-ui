import { describe, expect, it } from 'vitest';
import { applyPatch, buildExampleWorkflow, templateByKey } from '@nodepilot/shared';
import { simChanges, withDependencies } from './sim';

describe('simulation change list', () => {
  const base = buildExampleWorkflow('2026-01-01T00:00:00Z');

  it('ignores the sandbox name and reports nothing when nothing changed', () => {
    expect(simChanges(base, { ...base, id: 'sim_x', name: `${base.name} (simulation)` })).toEqual([]);
  });

  it('describes adds, edits, moves and connections in plain words', () => {
    const extra = templateByKey('empty')!.build('n_new', { x: 0, y: 900 });
    const sandbox = applyPatch(base, [
      { op: 'add_node', node: extra },
      { op: 'add_edge', edge: { id: 'e_new', source: 'n_scene_worker', sourcePort: 'scene', target: 'n_new', targetPort: 'in' } },
      { op: 'update_node', nodeId: 'n_judge_tension', changes: { label: 'Judge: suspense' } },
      { op: 'move_node', nodeId: 'n_scanner', position: { x: 1, y: 2 } },
    ]);
    const changes = simChanges(base, sandbox);
    const find = (verb: string) => changes.find((c) => c.verb === verb)!;
    expect(find('Added').title).toBe('“New step” (module)');
    expect(find('Connected').title).toBe('Scene worker → New step');
    expect(find('Edited').detail).toContain('renamed “Judge: tension” → “Judge: suspense”');
    expect(find('Moved').layoutOnly).toBe(true);
  });

  it('applying a new connection brings the new node with it, so main stays valid', () => {
    const extra = templateByKey('empty')!.build('n_new', { x: 0, y: 900 });
    const sandbox = applyPatch(base, [
      { op: 'add_node', node: extra },
      { op: 'add_edge', edge: { id: 'e_new', source: 'n_scene_worker', sourcePort: 'scene', target: 'n_new', targetPort: 'in' } },
    ]);
    const changes = simChanges(base, sandbox);
    const connect = changes.find((c) => c.verb === 'Connected')!;
    const group = withDependencies(changes, new Set([connect.key]), base);
    expect(group.map((c) => c.verb).sort()).toEqual(['Added', 'Connected']);
    // and the group really applies cleanly to the original
    expect(() => applyPatch(base, group.map((c) => c.op))).not.toThrow();
  });
});
