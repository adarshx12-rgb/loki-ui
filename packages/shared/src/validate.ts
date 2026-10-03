import { z } from 'zod';
import { findCycle, portsCompatible, stableStringify } from './graph.js';
import { redactValue } from './redact.js';
import { workflowSchema, type Workflow } from './schema.js';

/**
 * Issue severities:
 *  - `save`:  structural problem; the change is rejected and never persisted.
 *  - `run`:   the workflow can be saved but cannot be executed until fixed.
 *  - `warning`: informational; does not block anything.
 */
export type IssueLevel = 'save' | 'run' | 'warning';

export interface ValidationIssue {
  level: IssueLevel;
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  path?: string;
}

export interface ValidationContext {
  /** Returns whether a credential reference resolves to a value (without revealing it). */
  credentialAvailable?: (ref: string) => boolean;
  /** Known external service ids for observed nodes. */
  knownServiceIds?: Set<string>;
}

export interface ValidationResult {
  ok: boolean; // no save-level issues
  runnable: boolean; // no save- or run-level issues
  issues: ValidationIssue[];
}

function zodIssues(err: z.ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({
    level: 'save' as const,
    code: 'schema',
    message: `${i.path.join('.') || '(root)'}: ${i.message}`,
    path: i.path.join('.'),
  }));
}

/** Parses unknown input into a Workflow (applying defaults) or returns schema issues. */
export function parseWorkflow(input: unknown): { workflow?: Workflow; issues: ValidationIssue[] } {
  const r = workflowSchema.safeParse(input);
  if (!r.success) return { issues: zodIssues(r.error) };
  return { workflow: r.data, issues: [] };
}

export function validateWorkflow(input: unknown, ctx: ValidationContext = {}): ValidationResult & { workflow?: Workflow } {
  const parsed = parseWorkflow(input);
  if (!parsed.workflow) return { ok: false, runnable: false, issues: parsed.issues };
  const wf = parsed.workflow;
  const issues: ValidationIssue[] = [];
  const push = (i: ValidationIssue) => issues.push(i);

  // ---- structural (save-blocking) ----
  const nodes = new Map<string, Workflow['nodes'][number]>();
  for (const n of wf.nodes) {
    if (nodes.has(n.id)) push({ level: 'save', code: 'duplicate_node_id', message: `Duplicate node id "${n.id}"`, nodeId: n.id });
    nodes.set(n.id, n);
    const portIds = new Set<string>();
    for (const p of [...n.inputs, ...n.outputs]) {
      if (portIds.has(p.id)) push({ level: 'save', code: 'duplicate_port_id', message: `Node "${n.label}" has duplicate port id "${p.id}"`, nodeId: n.id });
      portIds.add(p.id);
    }
    const codeRefIds = new Set<string>();
    for (const c of n.codeRefs) {
      if (codeRefIds.has(c.id)) push({ level: 'save', code: 'duplicate_coderef_id', message: `Duplicate code reference id "${c.id}"`, nodeId: n.id });
      codeRefIds.add(c.id);
    }
    // Secrets must never live in workflow JSON.
    if (stableStringify(redactValue(n.config.params)) !== stableStringify(n.config.params)) {
      push({
        level: 'save',
        code: 'secret_in_params',
        message: `Node "${n.label}" params appear to contain a secret. Store it in the secret store and use a credentialRef instead.`,
        nodeId: n.id,
      });
    }
  }

  const edgeIds = new Set<string>();
  const incomingByPort = new Map<string, number>();
  const edgeKeys = new Set<string>();
  for (const e of wf.edges) {
    if (edgeIds.has(e.id)) push({ level: 'save', code: 'duplicate_edge_id', message: `Duplicate edge id "${e.id}"`, edgeId: e.id });
    edgeIds.add(e.id);
    const src = nodes.get(e.source);
    const tgt = nodes.get(e.target);
    if (!src || !tgt) {
      push({ level: 'save', code: 'dangling_edge', message: `Edge "${e.id}" references a missing node`, edgeId: e.id });
      continue;
    }
    if (e.source === e.target) {
      push({ level: 'save', code: 'self_loop', message: `Edge "${e.id}" connects "${src.label}" to itself`, edgeId: e.id });
      continue;
    }
    const sp = src.outputs.find((p) => p.id === e.sourcePort);
    const tp = tgt.inputs.find((p) => p.id === e.targetPort);
    if (!sp) {
      push({ level: 'save', code: 'missing_port', message: `"${src.label}" has no output port "${e.sourcePort}"`, edgeId: e.id, nodeId: src.id });
      continue;
    }
    if (!tp) {
      push({ level: 'save', code: 'missing_port', message: `"${tgt.label}" has no input port "${e.targetPort}"`, edgeId: e.id, nodeId: tgt.id });
      continue;
    }
    if (!portsCompatible(sp.type, tp.type)) {
      push({
        level: 'save',
        code: 'incompatible_ports',
        message: `Cannot connect "${src.label}.${sp.id}" (${sp.type}) to "${tgt.label}.${tp.id}" (${tp.type})`,
        edgeId: e.id,
      });
    }
    const key = `${e.source}:${e.sourcePort}->${e.target}:${e.targetPort}`;
    if (edgeKeys.has(key)) push({ level: 'save', code: 'duplicate_edge', message: `Duplicate connection ${key}`, edgeId: e.id });
    edgeKeys.add(key);
    const portKey = `${e.target}:${e.targetPort}`;
    const count = (incomingByPort.get(portKey) ?? 0) + 1;
    incomingByPort.set(portKey, count);
    if (count > 1 && !tp.multiple) {
      push({
        level: 'save',
        code: 'port_single_input',
        message: `Input "${tgt.label}.${tp.id}" accepts one connection; enable "multiple" with an explicit merge strategy to fan in`,
        edgeId: e.id,
        nodeId: tgt.id,
      });
    }
  }

  const cycle = findCycle(wf.nodes, wf.edges.filter((e) => nodes.has(e.source) && nodes.has(e.target)));
  if (cycle) {
    const labels = cycle.map((id) => nodes.get(id)?.label ?? id);
    push({ level: 'save', code: 'cycle', message: `Workflows must be acyclic. Cycle: ${labels.join(' → ')}`, nodeId: cycle[0] });
  }

  // ---- run-blocking ----
  for (const n of wf.nodes) {
    for (const p of n.inputs) {
      if (p.required && !incomingByPort.has(`${n.id}:${p.id}`)) {
        push({ level: 'run', code: 'missing_required_input', message: `"${n.label}" is missing required input "${p.label}"`, nodeId: n.id });
      }
    }
    const impl = n.config.implementation;
    switch (impl.kind) {
      case 'none':
        push({ level: 'run', code: 'not_configured', message: `"${n.label}" has no implementation (Not configured)`, nodeId: n.id });
        break;
      case 'script':
        push({
          level: 'run',
          code: 'script_unavailable',
          message: `"${n.label}" holds a draft script. Custom script execution is unavailable until an isolated runner exists.`,
          nodeId: n.id,
        });
        break;
      case 'model':
        if (!impl.credentialRef) {
          push({ level: 'run', code: 'missing_credential', message: `"${n.label}" needs a credentialRef for ${impl.provider}`, nodeId: n.id });
        } else if (ctx.credentialAvailable && !ctx.credentialAvailable(impl.credentialRef)) {
          push({ level: 'run', code: 'credential_unavailable', message: `"${n.label}": credential ${impl.credentialRef} is not set`, nodeId: n.id });
        }
        break;
      case 'observed':
        push({
          level: 'warning',
          code: 'observed_node',
          message: `"${n.label}" is observed from external service "${impl.serviceId}" and is never executed by NodePilot`,
          nodeId: n.id,
        });
        if (ctx.knownServiceIds && !ctx.knownServiceIds.has(impl.serviceId)) {
          push({ level: 'warning', code: 'unknown_service', message: `"${n.label}" references unknown service "${impl.serviceId}"`, nodeId: n.id });
        }
        break;
      case 'demo':
        if (n.config.demo.failMode !== 'none') {
          push({ level: 'warning', code: 'demo_fault', message: `"${n.label}" has demo fault injection "${n.config.demo.failMode}" enabled`, nodeId: n.id });
        }
        break;
    }
    if (n.config.retry.maxAttempts > 1 && !n.config.retry.safeToRetry) {
      push({
        level: 'warning',
        code: 'retry_not_safe',
        message: `"${n.label}" requests ${n.config.retry.maxAttempts} attempts but is not marked safeToRetry; it will run once`,
        nodeId: n.id,
      });
    }
  }
  if (wf.nodes.length === 0) push({ level: 'run', code: 'empty', message: 'Workflow has no nodes' });

  const ok = !issues.some((i) => i.level === 'save');
  const runnable = ok && !issues.some((i) => i.level === 'run');
  return { ok, runnable, issues, workflow: wf };
}
