/**
 * Visual vocabulary of the canvas:
 *  - circle         I/O endpoints
 *  - rect           main processing nodes (models, planners, workers, judges, …)
 *  - dashed         optional side branches (screeners, pre-judges, variants)
 *  - parallelogram  instructions / rules / prompts, attached to the top of a node
 *  - container      ensembles (e.g. a judge council)
 *  - diamond        routers / conditional branches
 *  - cylinder       data stores, caches, vector indexes, queues
 */
export type Shape = 'circle' | 'rect' | 'dashed' | 'parallelogram' | 'container' | 'diamond' | 'cylinder';

export const SHAPE_OF: Record<string, Shape> = {
  input: 'circle',
  output: 'circle',
  planner: 'rect',
  combiner: 'rect',
  scanner: 'rect',
  worker: 'rect',
  judge: 'rect',
  aggregator: 'rect',
  api_service: 'rect',
  model: 'rect',
  auxiliary: 'dashed',
  instruction: 'parallelogram',
  group: 'container',
  router: 'diamond',
  datastore: 'cylinder',
};

/** Header colour per kind (ComfyUI-style title bars). */
export const KIND_COLOR: Record<string, string> = {
  planner: '#3d5a80',
  combiner: '#4a5568',
  scanner: '#2f6f6a',
  worker: '#5a4a7a',
  judge: '#7a4a3a',
  aggregator: '#4a6a3a',
  api_service: '#4c3770',
  model: '#2b4673',
  auxiliary: '#3a3f4a',
  instruction: '#6b5220',
  router: '#5a3a5a',
  datastore: '#2c4a6b',
  input: '#2a5a3d',
  output: '#2a5a3d',
  group: '#262b33',
};

/** Edges to/from these kinds are drawn dashed (supporting rather than main-line data flow). */
export const DASHED_KINDS = new Set(['auxiliary', 'instruction', 'datastore', 'api_service']);
