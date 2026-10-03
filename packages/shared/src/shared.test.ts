import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  applyPostProcess,
  buildExampleWorkflow,
  diffWorkflows,
  executableHash,
  findCycle,
  redactString,
  redactValue,
  registerKnownSecret,
  templateByKey,
  validateWorkflow,
  type Workflow,
} from './index.js';

const example = () => buildExampleWorkflow('2026-01-01T00:00:00.000Z');
const codes = (wf: unknown) => validateWorkflow(wf).issues.map((i) => `${i.level}:${i.code}`);

describe('graph validation', () => {
  it('accepts the seeded example as saveable and runnable', () => {
    const r = validateWorkflow(example());
    expect(r.ok).toBe(true);
    expect(r.runnable).toBe(true);
  });

  it('detects cycles and reports the path', () => {
    const wf = example();
    wf.nodes.find((n) => n.id === 'n_query')!.inputs = [{ id: 'loop', label: 'Loop', type: 'any', required: false, multiple: false, merge: 'array' }];
    wf.edges.push({ id: 'back', source: 'n_results', sourcePort: 'x', target: 'n_query', targetPort: 'loop' });
    // results has no outputs: add one so the edge is otherwise valid
    wf.nodes.find((n) => n.id === 'n_results')!.outputs = [{ id: 'x', label: 'x', type: 'report' }];
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    const cyc = r.issues.find((i) => i.code === 'cycle');
    expect(cyc?.message).toMatch(/Cycle: .*User query.*→/);
    expect(findCycle(wf.nodes, wf.edges)).not.toBeNull();
  });

  it('flags incompatible ports, missing ports and fan-in to single ports', () => {
    const wf = example();
    wf.edges.push({ id: 'bad1', source: 'n_query', sourcePort: 'query', target: 'n_scanner', targetPort: 'plan' }); // text → plan
    wf.edges.push({ id: 'bad2', source: 'n_query', sourcePort: 'nope', target: 'n_scanner', targetPort: 'plan' });
    const c = codes(wf);
    expect(c).toContain('save:incompatible_ports');
    expect(c).toContain('save:missing_port');
    expect(c).toContain('save:port_single_input');
  });

  it('reports missing required inputs, missing implementation and credentials as run-blocking', () => {
    const wf = example();
    wf.edges = wf.edges.filter((e) => e.id !== 'e6'); // scanner → scene worker removed
    wf.nodes.push(templateByKey('empty')!.build('n_empty', { x: 0, y: 0 }));
    wf.nodes.push(templateByKey('model')!.build('n_model', { x: 0, y: 0 }));
    const r = validateWorkflow(wf, { credentialAvailable: () => false });
    expect(r.ok).toBe(true);
    expect(r.runnable).toBe(false);
    const c = r.issues.map((i) => i.code);
    expect(c).toContain('missing_required_input');
    expect(c).toContain('not_configured');
    expect(c).toContain('missing_credential');
  });

  it('rejects secrets stored in params and invalid settings', () => {
    const wf = example();
    wf.nodes[0].config.params = { apiKey: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' };
    expect(codes(wf)).toContain('save:secret_in_params');
    const bad = example() as unknown as { nodes: { config: { timeoutMs: number } }[] };
    bad.nodes[0].config.timeoutMs = -5;
    expect(codes(bad)[0]).toBe('save:schema');
  });

  it('rejects traversal in code references', () => {
    const wf = example();
    wf.nodes[0].codeRefs = [{ id: 'r', path: '../../etc/passwd' }];
    expect(codes(wf)).toContain('save:schema');
  });
});

describe('patches', () => {
  it('moving a node does not change the executable hash', () => {
    const wf = example();
    const moved = applyPatch(wf, [{ op: 'move_node', nodeId: 'n_scanner', position: { x: 9999, y: -3 } }]);
    expect(executableHash(moved)).toBe(executableHash(wf));
    const changed = applyPatch(wf, [{ op: 'update_node', nodeId: 'n_scanner', changes: { config: { timeoutMs: 1234 } } }]);
    expect(executableHash(changed)).not.toBe(executableHash(wf));
    // partial config update keeps other config keys
    expect(changed.nodes.find((n) => n.id === 'n_scanner')!.config.implementation.kind).toBe('demo');
  });

  it('diffWorkflows round-trips', () => {
    const a = example();
    const b: Workflow = applyPatch(a, [
      { op: 'remove_node', nodeId: 'n_judge_fidelity' },
      { op: 'move_node', nodeId: 'n_query', position: { x: 1, y: 2 } },
      { op: 'update_node', nodeId: 'n_scanner', changes: { label: 'Scanner v2' } },
      { op: 'update_workflow', name: 'Renamed' },
    ]);
    const ops = diffWorkflows(a, b);
    const c = applyPatch(a, ops);
    expect(JSON.stringify({ ...c, updatedAt: '' })).toBe(JSON.stringify({ ...b, updatedAt: '' }));
  });
});

describe('post-processing', () => {
  it('supports select, map, filter, sort and limit', () => {
    const data = { report: { scores: [{ c: 'a', s: 3 }, { c: 'b', s: 9 }, { c: 'c', s: 6 }] }, extra: 1 };
    const out = applyPostProcess(data, [
      { op: 'select', fields: ['report.scores'] },
      { op: 'filter', path: 'report.scores', where: { field: 's', cmp: 'gte', value: 5 } },
      { op: 'sort', path: 'report.scores', by: 's', order: 'desc' },
      { op: 'limit', path: 'report.scores', count: 1 },
      { op: 'map', mapping: { best: 'report.scores' } },
    ]);
    expect(out).toEqual({ best: [{ c: 'b', s: 9 }] });
  });
  it('ignores prototype paths', () => {
    expect(applyPostProcess({ a: 1 }, [{ op: 'map', mapping: { x: 'constructor.name' } }])).toEqual({ x: undefined });
  });
});

describe('secret redaction', () => {
  it('redacts well-known token formats and keyed secrets', () => {
    const text = 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA and ghp_123456789012345678901234 Authorization: Bearer abc.def password="hunter22" maxTokens: 1024';
    const out = redactString(text);
    expect(out).not.toMatch(/sk-ant-api03|ghp_1234|hunter22|abc\.def/);
    expect(out).toContain('maxTokens: 1024');
  });
  it('redacts registered secret values and secret-named keys deeply', () => {
    registerKnownSecret('my-very-private-value');
    const out = redactValue({ msg: 'leak: my-very-private-value', nested: { client_secret: 'x', token_count: 5, credentialRef: 'env:X' } });
    expect(JSON.stringify(out)).not.toContain('my-very-private-value');
    expect(out.nested.client_secret).toBe('[REDACTED]');
    expect(out.nested.token_count).toBe(5);
    expect(out.nested.credentialRef).toBe('env:X');
  });
  it('redacts private keys in diffs', () => {
    const diff = '+-----BEGIN RSA PRIVATE KEY-----\n+MIIEow\n+-----END RSA PRIVATE KEY-----\n';
    expect(redactString(diff)).not.toContain('MIIEow');
  });
});
