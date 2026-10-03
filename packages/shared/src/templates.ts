import { nodeSchema, type NodeKind, type WorkflowNode, type WorkflowNodeInput, type Workflow, SCHEMA_VERSION } from './schema.js';

export interface NodeTemplate {
  key: string;
  kind: NodeKind;
  label: string;
  description: string;
  build: (id: string, position: { x: number; y: number }) => WorkflowNode;
}

function node(input: WorkflowNodeInput): WorkflowNode {
  return nodeSchema.parse(input);
}

const demo = (handler: string) => ({ implementation: { kind: 'demo' as const, handler: handler as never } });

/** Palette entries. Demo templates run deterministic local handlers; others start "Not configured". */
export const NODE_TEMPLATES: NodeTemplate[] = [
  {
    key: 'user_query', kind: 'input', label: 'User query', description: 'Workflow entry point emitting the query text (demo).',
    build: (id, position) => node({ id, kind: 'input', label: 'User query', position, outputs: [{ id: 'query', label: 'Query', type: 'text' }], config: { ...demo('user_query'), params: { query: 'Find the most suspenseful scene' } } }),
  },
  {
    key: 'planner', kind: 'planner', label: 'Planner', description: 'Turns a query into a plan (demo).',
    build: (id, position) => node({ id, kind: 'planner', label: 'Planner', position, inputs: [{ id: 'query', label: 'Query', type: 'text' }], outputs: [{ id: 'plan', label: 'Plan', type: 'plan' }], config: { ...demo('planner'), params: { strategy: 'breadth' } } }),
  },
  {
    key: 'plan_combiner', kind: 'combiner', label: 'Plan combiner', description: 'Merges several plans (explicit array merge).',
    build: (id, position) => node({ id, kind: 'combiner', label: 'Plan combiner', position, inputs: [{ id: 'plans', label: 'Plans', type: 'plan', multiple: true, merge: 'array' }], outputs: [{ id: 'plan', label: 'Plan', type: 'plan' }], config: demo('plan_combiner') }),
  },
  {
    key: 'scanner', kind: 'scanner', label: 'Scanner', description: 'Scans the corpus following a plan (demo).',
    build: (id, position) => node({ id, kind: 'scanner', label: 'Scanner', position, inputs: [{ id: 'plan', label: 'Plan', type: 'plan' }], outputs: [{ id: 'scan', label: 'Scan', type: 'scan' }], config: demo('scanner') }),
  },
  {
    key: 'scene_worker', kind: 'worker', label: 'Scene worker', description: 'Builds a scene from scan results (demo).',
    build: (id, position) => node({ id, kind: 'worker', label: 'Scene worker', position, inputs: [{ id: 'scan', label: 'Scan', type: 'scan' }], outputs: [{ id: 'scene', label: 'Scene', type: 'scene' }], config: demo('scene_worker') }),
  },
  {
    key: 'judge', kind: 'judge', label: 'Judge', description: 'Scores a scene against one criterion (demo).',
    build: (id, position) => node({ id, kind: 'judge', label: 'Judge', position, inputs: [{ id: 'scene', label: 'Scene', type: 'scene' }], outputs: [{ id: 'score', label: 'Score', type: 'score' }], config: { ...demo('judge'), params: { criterion: 'coherence' }, retry: { maxAttempts: 2, backoffMs: 200, safeToRetry: true } } }),
  },
  {
    key: 'score_combiner', kind: 'aggregator', label: 'Score combiner', description: 'Aggregates judge scores (explicit keyed merge).',
    build: (id, position) => node({ id, kind: 'aggregator', label: 'Score combiner', position, inputs: [{ id: 'scores', label: 'Scores', type: 'score', multiple: true, merge: 'object_by_source' }], outputs: [{ id: 'report', label: 'Report', type: 'report' }], config: demo('score_combiner') }),
  },
  {
    key: 'results', kind: 'output', label: 'Results', description: 'Terminal output node.',
    build: (id, position) => node({ id, kind: 'output', label: 'Results', position, inputs: [{ id: 'report', label: 'Report', type: 'any' }], config: demo('results') }),
  },
  {
    key: 'model', kind: 'model', label: 'Model call', description: 'Real model call via an adapter. Needs a credential reference.',
    build: (id, position) => node({ id, kind: 'model', label: 'Model call', position, inputs: [{ id: 'prompt', label: 'Prompt', type: 'any' }], outputs: [{ id: 'text', label: 'Text', type: 'text' }], config: { implementation: { kind: 'model', provider: 'anthropic', model: 'claude-haiku-4-5', maxTokens: 512 }, timeoutMs: 60_000 } }),
  },
  {
    key: 'api_service', kind: 'api_service', label: 'Observed API service', description: 'A node implemented by an external backend; observed, never executed here.',
    build: (id, position) => node({ id, kind: 'api_service', label: 'API service', position, inputs: [{ id: 'in', label: 'In', type: 'any', required: false }], outputs: [{ id: 'out', label: 'Out', type: 'json' }], config: { implementation: { kind: 'observed', serviceId: 'example-backend' } } }),
  },
  {
    key: 'empty', kind: 'worker', label: 'Empty worker', description: 'Blank node with no implementation (shows "Not configured").',
    build: (id, position) => node({ id, kind: 'worker', label: 'New worker', position, inputs: [{ id: 'in', label: 'In', type: 'any' }], outputs: [{ id: 'out', label: 'Out', type: 'json' }], config: { implementation: { kind: 'none' } } }),
  },
];

export function templateByKey(key: string): NodeTemplate | undefined {
  return NODE_TEMPLATES.find((t) => t.key === key);
}

export const EXAMPLE_WORKFLOW_ID = 'example-scene-pipeline';

/**
 * Illustrative example only. It is NOT inferred from any user repository.
 * User query → two planners → plan combiner → scanner → scene worker → three judges → score combiner → results.
 */
export function buildExampleWorkflow(now = new Date().toISOString()): Workflow {
  const t = (key: string) => templateByKey(key)!;
  const X = 260;
  const nodes: WorkflowNode[] = [
    t('user_query').build('n_query', { x: 0, y: 220 }),
    { ...t('planner').build('n_planner_a', { x: X, y: 120 }), label: 'Planner A (breadth)' },
    { ...t('planner').build('n_planner_b', { x: X, y: 320 }), label: 'Planner B (depth)' },
    t('plan_combiner').build('n_plan_combiner', { x: X * 2, y: 220 }),
    t('scanner').build('n_scanner', { x: X * 3, y: 220 }),
    t('scene_worker').build('n_scene_worker', { x: X * 4, y: 220 }),
    { ...t('judge').build('n_judge_coherence', { x: X * 5, y: 80 }), label: 'Judge: coherence' },
    { ...t('judge').build('n_judge_tension', { x: X * 5, y: 220 }), label: 'Judge: tension' },
    { ...t('judge').build('n_judge_fidelity', { x: X * 5, y: 360 }), label: 'Judge: fidelity' },
    t('score_combiner').build('n_score_combiner', { x: X * 6, y: 220 }),
    t('results').build('n_results', { x: X * 7, y: 220 }),
  ];
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  byId.n_planner_b.config.params = { strategy: 'depth' };
  byId.n_judge_tension.config.params = { criterion: 'tension' };
  byId.n_judge_fidelity.config.params = { criterion: 'fidelity' };
  byId.n_query.notes = '**Example workflow** — illustrative only, not inferred from your repository.\n\nAll nodes use deterministic *demo* handlers that run locally and label their output as demo data.';
  byId.n_scene_worker.instructions = 'Given scan hits, assemble the single most relevant scene. Cite the source line for every claim.';
  byId.n_scene_worker.codeRefs = [{ id: 'ref1', path: 'src/workers/scene.ts', symbol: 'buildScene', note: 'Example mapping; edit to match your repository' }];

  const e = (id: string, source: string, sourcePort: string, target: string, targetPort: string) => ({ id, source, sourcePort, target, targetPort });
  return {
    schemaVersion: SCHEMA_VERSION,
    id: EXAMPLE_WORKFLOW_ID,
    name: 'Example: scene pipeline (demo)',
    description: 'Clearly labelled illustrative example. Every node runs a deterministic local demo handler.',
    revision: 1,
    isExample: true,
    nodes,
    edges: [
      e('e1', 'n_query', 'query', 'n_planner_a', 'query'),
      e('e2', 'n_query', 'query', 'n_planner_b', 'query'),
      e('e3', 'n_planner_a', 'plan', 'n_plan_combiner', 'plans'),
      e('e4', 'n_planner_b', 'plan', 'n_plan_combiner', 'plans'),
      e('e5', 'n_plan_combiner', 'plan', 'n_scanner', 'plan'),
      e('e6', 'n_scanner', 'scan', 'n_scene_worker', 'scan'),
      e('e7', 'n_scene_worker', 'scene', 'n_judge_coherence', 'scene'),
      e('e8', 'n_scene_worker', 'scene', 'n_judge_tension', 'scene'),
      e('e9', 'n_scene_worker', 'scene', 'n_judge_fidelity', 'scene'),
      e('e10', 'n_judge_coherence', 'score', 'n_score_combiner', 'scores'),
      e('e11', 'n_judge_tension', 'score', 'n_score_combiner', 'scores'),
      e('e12', 'n_judge_fidelity', 'score', 'n_score_combiner', 'scores'),
      e('e13', 'n_score_combiner', 'report', 'n_results', 'report'),
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export function newId(prefix: string): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
  return `${prefix}_${rand}`;
}
