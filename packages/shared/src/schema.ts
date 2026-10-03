import { z } from 'zod';

/**
 * NodePilot workflow schema, version 1.
 *
 * Layout (position/display) is deliberately kept apart from `config`, which is the
 * only part of a node that affects execution. See `executableHash` in graph.ts.
 */
export const SCHEMA_VERSION = 1 as const;

export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'IDs may contain letters, digits, "_" and "-" (max 64 chars)');

export const PORT_TYPES = ['any', 'text', 'json', 'plan', 'plans', 'scan', 'scene', 'score', 'scores', 'report', 'rules'] as const;
export const portTypeSchema = z.enum(PORT_TYPES);
export type PortType = z.infer<typeof portTypeSchema>;

export const inputPortSchema = z.object({
  id: idSchema,
  label: z.string().max(80),
  type: portTypeSchema,
  required: z.boolean().default(true),
  /** Accept more than one incoming edge. Requires an explicit merge strategy. */
  multiple: z.boolean().default(false),
  /** How multiple incoming values are merged: an array ordered by edge id, or an object keyed by source node id. */
  merge: z.enum(['array', 'object_by_source']).default('array'),
});
export type InputPort = z.infer<typeof inputPortSchema>;

export const outputPortSchema = z.object({
  id: idSchema,
  label: z.string().max(80),
  type: portTypeSchema,
});
export type OutputPort = z.infer<typeof outputPortSchema>;

export const NODE_KINDS = [
  'input',
  'planner',
  'combiner',
  'scanner',
  'worker',
  'judge',
  'aggregator',
  'api_service',
  'model',
  'output',
  /** Prompt templates, rules and policies; rendered as a parallelogram attached to the top of the node it governs. */
  'instruction',
  /** Optional side branch (screeners, pre-judges, alternate variants); rendered dashed. */
  'auxiliary',
  /** Visual container for an ensemble (e.g. a judge council). Never executed. */
  'group',
  /** Conditional branch / dispatcher; rendered as a diamond. */
  'router',
  /** Database, cache, vector index or queue; rendered as a cylinder. */
  'datastore',
  /** A generic module, folder or step of a project; makes no claim about what it does. */
  'module',
  /** User-facing screens and components. */
  'ui',
] as const;
export const nodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const DEMO_HANDLERS = [
  'user_query',
  'planner',
  'plan_combiner',
  'scanner',
  'scene_worker',
  'judge',
  'score_combiner',
  'results',
  'echo',
  'instruction',
] as const;

/** Kinds that are layout only and never scheduled or validated for execution. */
export const VISUAL_ONLY_KINDS: ReadonlySet<string> = new Set(['group']);

/** `env:NAME` reads an environment variable of the server; `secret:name` reads the local secret store. Never a raw secret. */
export const credentialRefSchema = z
  .string()
  .regex(/^(env:[A-Z_][A-Z0-9_]{0,127}|secret:[a-z0-9][a-z0-9._-]{0,63})$/, 'Credential references look like "env:ANTHROPIC_API_KEY" or "secret:my-key"');

export const implementationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('demo'),
    handler: z.enum(DEMO_HANDLERS),
  }),
  z.object({
    kind: z.literal('model'),
    provider: z.enum(['anthropic']),
    model: z.string().min(1).max(100),
    credentialRef: credentialRefSchema.optional(),
    maxTokens: z.number().int().min(1).max(64000).default(1024),
    temperature: z.number().min(0).max(1).optional(),
  }),
  z.object({
    /** A node implemented by an external backend. NodePilot never executes it; it only observes telemetry. */
    kind: z.literal('observed'),
    serviceId: idSchema,
    externalNodeId: z.string().max(128).optional(),
  }),
  z.object({
    /** Script text stored as a draft only. Execution is unavailable until an isolated runner exists. */
    kind: z.literal('script'),
    language: z.enum(['javascript', 'python']),
    source: z.string().max(50_000),
  }),
  z.object({ kind: z.literal('none') }),
]);
export type Implementation = z.infer<typeof implementationSchema>;

const cmpSchema = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']);
const pathSchema = z.string().regex(/^[A-Za-z0-9_$][A-Za-z0-9_$]*(\.[A-Za-z0-9_$]+)*$|^$/, 'Use dot paths like "scores.total"').max(200);

export const postProcessStepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('select'), fields: z.array(pathSchema.min(1)).min(1).max(50) }),
  z.object({ op: z.literal('map'), mapping: z.record(z.string().regex(/^[A-Za-z0-9_$]+$/), pathSchema).refine((m) => Object.keys(m).length <= 50) }),
  z.object({
    op: z.literal('filter'),
    path: pathSchema,
    where: z.object({ field: pathSchema, cmp: cmpSchema, value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional() }),
  }),
  z.object({ op: z.literal('sort'), path: pathSchema, by: pathSchema, order: z.enum(['asc', 'desc']).default('asc') }),
  z.object({ op: z.literal('limit'), path: pathSchema, count: z.number().int().min(0).max(10_000) }),
]);
export type PostProcessStep = z.infer<typeof postProcessStepSchema>;

export const nodeConfigSchema = z.object({
  implementation: implementationSchema,
  /** Handler-specific parameters. Must not contain secrets. */
  params: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(5).default(1),
      backoffMs: z.number().int().min(0).max(60_000).default(500),
      /** Retries only happen when the operation is declared idempotent / side-effect free. */
      safeToRetry: z.boolean().default(false),
    })
    .default({ maxAttempts: 1, backoffMs: 500, safeToRetry: false }),
  postProcess: z.array(postProcessStepSchema).max(20).default([]),
  /** Deterministic fault injection for demo handlers only. Clearly labelled in the UI. */
  demo: z
    .object({
      failMode: z.enum(['none', 'error', 'timeout']).default('none'),
      latencyMs: z.number().int().min(0).max(10_000).default(150),
    })
    .default({ failMode: 'none', latencyMs: 150 }),
});
export type NodeConfig = z.infer<typeof nodeConfigSchema>;

export const codeRefSchema = z.object({
  id: idSchema,
  /** Repository-relative path using forward slashes. */
  path: z
    .string()
    .min(1)
    .max(400)
    .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0'), {
      message: 'Code references must be repository-relative and may not contain ".."',
    }),
  symbol: z.string().max(200).optional(),
  line: z.number().int().min(1).optional(),
  note: z.string().max(500).optional(),
});
export type CodeRef = z.infer<typeof codeRefSchema>;

export const nodeSchema = z.object({
  id: idSchema,
  kind: nodeKindSchema,
  label: z.string().min(1).max(120),
  purpose: z.string().max(2000).default(''),
  // ---- visual only ----
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  display: z
    .object({
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      collapsed: z.boolean().optional(),
      /** Size of resizable nodes (groups). */
      width: z.number().int().min(80).max(6000).optional(),
      height: z.number().int().min(60).max(6000).optional(),
    })
    .default({}),
  // ---- contracts ----
  inputs: z.array(inputPortSchema).max(20).default([]),
  outputs: z.array(outputPortSchema).max(20).default([]),
  // ---- executable ----
  config: nodeConfigSchema,
  // ---- documentation ----
  notes: z.string().max(100_000).default(''),
  instructions: z.string().max(100_000).default(''),
  codeRefs: z.array(codeRefSchema).max(50).default([]),
});
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type WorkflowNodeInput = z.input<typeof nodeSchema>;

export const edgeSchema = z.object({
  id: idSchema,
  source: idSchema,
  sourcePort: idSchema,
  target: idSchema,
  targetPort: idSchema,
  label: z.string().max(80).optional(),
});
export type WorkflowEdge = z.infer<typeof edgeSchema>;

export const workflowSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: idSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(5000).default(''),
  /** Monotonic revision used for optimistic concurrency. */
  revision: z.number().int().min(0),
  /** True for the bundled illustrative example. */
  isExample: z.boolean().default(false),
  /** Set on a simulation sandbox: the id of the workflow it was copied from. Sandboxes are hidden from lists. */
  simulationOf: idSchema.optional(),
  /** ID of an approved project root used to resolve code references. */
  projectId: idSchema.optional(),
  nodes: z.array(nodeSchema).max(500),
  edges: z.array(edgeSchema).max(2000),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowInput = z.input<typeof workflowSchema>;

/** Actor recorded in the audit log for every mutation. */
export const actorSchema = z.enum(['ui', 'mcp', 'file', 'system', 'runner']);
export type Actor = z.infer<typeof actorSchema>;
