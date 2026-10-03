import { z } from 'zod';

// ---------------- Local execution (runs executed by NodePilot) ----------------

export const NODE_RUN_STATUSES = ['pending', 'queued', 'running', 'retrying', 'succeeded', 'failed', 'skipped', 'cancelled', 'observed'] as const;
export type NodeRunStatus = (typeof NODE_RUN_STATUSES)[number];
export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface NodeRunState {
  nodeId: string;
  status: NodeRunStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  truncated?: boolean;
  error?: { message: string; code?: string; upstream?: string };
  /** True if the output is deterministic demo data, not from a model or service. */
  demo?: boolean;
  /** Only present when a provider actually reported it. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Why the node was skipped/observed. */
  reason?: string;
}

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowRevision: number;
  executableHash: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  input?: unknown;
  /** Who started it. */
  actor: string;
}

export interface RunDetail extends RunSummary {
  nodes: Record<string, NodeRunState>;
}

export interface RunEvent {
  seq: number;
  runId: string;
  nodeId?: string;
  type: string;
  at: string;
  message?: string;
  data?: unknown;
}

// ---------------- External telemetry (runs observed from an instrumented backend) ----------------

export const TELEMETRY_STATUSES = ['started', 'succeeded', 'failed', 'evaluation_passed', 'evaluation_failed'] as const;

export const telemetryEventSchema = z.object({
  eventId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(128),
  workflowId: z.string().min(1).max(64),
  workflowRevision: z.number().int().min(0).optional(),
  environment: z.string().max(64).optional(),
  codeRevision: z.string().max(80).optional(),
  timestamp: z.iso.datetime({ offset: true }),
  status: z.enum(TELEMETRY_STATUSES),
  durationMs: z.number().min(0).max(86_400_000).optional(),
  error: z.object({ type: z.string().max(120).optional(), message: z.string().max(2000) }).optional(),
  output: z
    .object({
      summary: z.string().max(2000).optional(),
      sizeBytes: z.number().int().min(0).optional(),
      fields: z.array(z.string().max(100)).max(50).optional(),
    })
    .optional(),
  usage: z.object({ inputTokens: z.number().int().min(0).optional(), outputTokens: z.number().int().min(0).optional() }).optional(),
  evaluation: z.object({ name: z.string().max(120), score: z.number().optional(), threshold: z.number().optional() }).optional(),
});
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

export const telemetryBatchSchema = z.object({ events: z.array(telemetryEventSchema).min(1).max(500) });

/** Precedence for out-of-order delivery: a later-ranked status is never overwritten by an earlier-ranked one. */
export function telemetryStatusRank(status: (typeof TELEMETRY_STATUSES)[number]): number {
  return status === 'started' ? 1 : status === 'succeeded' || status === 'failed' ? 2 : 3;
}

// ---------------- Live update bus (SSE) ----------------

export type BusEvent =
  | { type: 'workflow.updated'; workflowId: string; revision: number; actor: string; summary: string }
  | { type: 'workflow.created'; workflowId: string }
  | { type: 'workflow.deleted'; workflowId: string }
  | { type: 'workflow.conflict'; workflowId: string; message: string; source: string }
  | { type: 'run.event'; event: RunEvent; workflowId: string }
  | { type: 'run.updated'; run: RunSummary }
  | { type: 'proposal.created'; workflowId: string; proposalId: string }
  | { type: 'task.updated'; taskId: string; status: string }
  | { type: 'task.event'; taskId: string; event: TaskEvent }
  | { type: 'runner.updated' }
  | { type: 'telemetry.updated'; workflowId: string; serviceId?: string }
  | { type: 'health.updated'; targetId: string }
  | { type: 'github.updated' }
  | { type: 'settings.updated' };

// ---------------- Claude tasks ----------------

export const TASK_STATUSES = [
  'draft',
  'queued', // approved in browser, waiting for runner
  'claimed', // runner picked it up
  'awaiting_local_confirmation', // runner shows it in the terminal and waits for y/N
  'running',
  'testing',
  'completed',
  'failed',
  'cancelled',
  'rejected', // declined at the runner
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskEvent {
  seq: number;
  at: string;
  kind: 'status' | 'assistant' | 'tool_use' | 'tool_result' | 'permission_denied' | 'error' | 'log' | 'result' | 'system';
  text: string;
  data?: unknown;
}

export const PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'dontAsk'] as const;
export type PermissionModeChoice = (typeof PERMISSION_MODES)[number];
