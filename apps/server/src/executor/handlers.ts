import { fnv1a, type WorkflowNode } from '@nodepilot/shared';
import { abortableSleep, NodeError, type Handler, type HandlerContext, type Resolution } from './scheduler.js';

export const DEMO_LABEL = 'DEMO DATA — produced by a deterministic local handler, not by a model or real service';

/** Small illustrative corpus used by the demo scanner. */
const SAMPLE_SCENES = [
  { id: 'scene-01', title: 'The lighthouse at dusk', text: 'Mara climbs the lighthouse as the storm gathers; the lamp will not light.', tags: ['storm', 'lighthouse', 'tension', 'night'] },
  { id: 'scene-02', title: 'Harbour market', text: 'Vendors argue over prices while a stranger watches the boats.', tags: ['market', 'stranger', 'harbour', 'day'] },
  { id: 'scene-03', title: 'The locked cellar', text: 'Footsteps above; the cellar door is bolted from outside. Mara counts her breaths.', tags: ['suspense', 'cellar', 'locked', 'tension', 'night'] },
  { id: 'scene-04', title: 'Letters in the attic', text: 'Old letters reveal the keeper had a daughter nobody remembers.', tags: ['mystery', 'attic', 'letters', 'reveal'] },
  { id: 'scene-05', title: 'The rescue', text: 'Rowing into the swell, Mara reaches the stranded boat seconds before it capsizes.', tags: ['storm', 'rescue', 'tension', 'climax'] },
];

const words = (text: string) => (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 3);
const hashInt = (s: string, mod: number) => parseInt(fnv1a(s).slice(0, 8), 16) % mod;

const demoHandlers: Record<string, (ctx: HandlerContext) => Record<string, unknown>> = {
  user_query: ({ node, runInput }) => {
    const override = runInput && typeof runInput === 'object' ? (runInput as { query?: unknown }).query : undefined;
    const query = typeof override === 'string' && override ? override : String(node.config.params.query ?? '');
    return { [node.outputs[0]?.id ?? 'query']: query };
  },
  planner: ({ node, inputs }) => {
    const query = String(inputs.query ?? Object.values(inputs)[0] ?? '');
    const strategy = String(node.config.params.strategy ?? 'breadth');
    const terms = words(query);
    const steps = strategy === 'depth'
      ? terms.slice(0, 2).flatMap((t) => [`deep-dive:${t}`, `verify:${t}`])
      : terms.map((t) => `search:${t}`);
    return { plan: { _label: DEMO_LABEL, strategy, terms, steps } };
  },
  plan_combiner: ({ inputs }) => {
    const plans = (Array.isArray(inputs.plans) ? inputs.plans : Object.values(inputs)) as { terms?: string[]; steps?: string[]; strategy?: string }[];
    const terms = [...new Set(plans.flatMap((p) => p?.terms ?? []))];
    const steps = [...new Set(plans.flatMap((p) => p?.steps ?? []))];
    return { plan: { _label: DEMO_LABEL, strategy: 'combined', sources: plans.map((p) => p?.strategy), terms, steps } };
  },
  scanner: ({ inputs }) => {
    const plan = inputs.plan as { terms?: string[] } | undefined;
    const terms = new Set([...(plan?.terms ?? []), 'tension', 'suspense']);
    const hits = SAMPLE_SCENES.map((s) => ({ sceneId: s.id, title: s.title, matches: s.tags.filter((t) => terms.has(t)).length + words(s.text).filter((w) => terms.has(w)).length }))
      .filter((h) => h.matches > 0)
      .sort((a, b) => b.matches - a.matches || a.sceneId.localeCompare(b.sceneId));
    return { scan: { _label: DEMO_LABEL, corpus: 'built-in sample (5 scenes)', hits } };
  },
  scene_worker: ({ inputs }) => {
    const scan = inputs.scan as { hits?: { sceneId: string }[] } | undefined;
    const top = scan?.hits?.[0];
    if (!top) throw new NodeError('No scan hits to build a scene from', 'no_input', false);
    const s = SAMPLE_SCENES.find((x) => x.id === top.sceneId)!;
    return { scene: { _label: DEMO_LABEL, id: s.id, title: s.title, excerpt: s.text, citations: [`${s.id}:L1`] } };
  },
  judge: ({ node, inputs }) => {
    const scene = inputs.scene as { id?: string } | undefined;
    const criterion = String(node.config.params.criterion ?? 'quality');
    const score = 4 + hashInt(`${scene?.id}:${criterion}`, 6); // 4..9, deterministic
    return { score: { _label: DEMO_LABEL, criterion, score, max: 10, rationale: `Deterministic demo score for ${criterion}` } };
  },
  score_combiner: ({ inputs }) => {
    const raw = inputs.scores;
    const entries = (raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw) : (Array.isArray(raw) ? raw.map((v, i) => [String(i), v]) : [])) as [string, { criterion?: string; score?: number }][];
    const scores = entries.map(([source, s]) => ({ source, criterion: s?.criterion, score: Number(s?.score ?? 0) }));
    const mean = scores.length ? Math.round((scores.reduce((a, b) => a + b.score, 0) / scores.length) * 100) / 100 : 0;
    return { report: { _label: DEMO_LABEL, scores, mean, verdict: mean >= 6 ? 'pass' : 'needs-work' } };
  },
  results: ({ inputs }) => ({ ...Object.fromEntries(Object.entries(inputs)), _label: DEMO_LABEL }),
  echo: ({ node, inputs }) => Object.fromEntries(node.outputs.map((p) => [p.id, inputs])),
};

function demoHandler(name: string): Handler {
  return async (ctx) => {
    const fn = demoHandlers[name];
    if (!fn) throw new NodeError(`Unknown demo handler "${name}"`, 'not_configured', false);
    const { failMode, latencyMs } = ctx.node.config.demo;
    if (failMode === 'timeout') {
      await abortableSleep(ctx.node.config.timeoutMs + 60_000, ctx.signal);
    }
    if (latencyMs) await abortableSleep(latencyMs, ctx.signal);
    if (failMode === 'error') throw new NodeError('Demo fault injection: this node is configured to fail (config.demo.failMode = "error")', 'demo_fault', false);
    const out = fn(ctx);
    // Terminal nodes without output ports still record what they received.
    return { outputs: ctx.node.outputs.length ? out : { result: out }, demo: true };
  };
}

export interface CredentialResolver {
  available(ref: string): boolean;
  resolve(ref: string): string | undefined;
}

/** Real model adapter (Anthropic Messages API). Only used when a credentialRef resolves. */
function anthropicHandler(creds: CredentialResolver, fetchImpl: typeof fetch = fetch): Handler {
  return async ({ node, inputs, signal }) => {
    const impl = node.config.implementation;
    if (impl.kind !== 'model') throw new NodeError('Not a model node', 'not_configured', false);
    const key = impl.credentialRef ? creds.resolve(impl.credentialRef) : undefined;
    if (!key) throw new NodeError(`Not configured: credential ${impl.credentialRef ?? '(none)'} is not set`, 'not_configured', false);
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: impl.model,
        max_tokens: impl.maxTokens,
        ...(impl.temperature !== undefined ? { temperature: impl.temperature } : {}),
        ...(node.instructions ? { system: node.instructions } : {}),
        messages: [{ role: 'user', content: typeof inputs.prompt === 'string' ? inputs.prompt : JSON.stringify(inputs) }],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };
    if (!res.ok) {
      // 429/5xx are transient; 4xx otherwise are not worth retrying.
      throw new NodeError(`Anthropic API ${res.status}: ${body.error?.message ?? 'request failed'}`, 'provider_error', res.status === 429 || res.status >= 500);
    }
    const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const outPort = node.outputs[0]?.id ?? 'text';
    return { outputs: { [outPort]: text }, demo: false, usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens } };
  };
}

/** Maps a node to how (or whether) NodePilot executes it. */
export function makeResolver(creds: CredentialResolver, fetchImpl?: typeof fetch): (node: WorkflowNode) => Resolution {
  return (node) => {
    const impl = node.config.implementation;
    switch (impl.kind) {
      case 'demo':
        return { kind: 'execute', handler: demoHandler(impl.handler) };
      case 'model':
        if (!impl.credentialRef || !creds.available(impl.credentialRef)) {
          return { kind: 'unavailable', code: 'not_configured', reason: `Not configured: model node needs credential ${impl.credentialRef ?? '(none set)'}` };
        }
        return { kind: 'execute', handler: anthropicHandler(creds, fetchImpl) };
      case 'observed':
        return { kind: 'observed', reason: `Implemented by external service "${impl.serviceId}". Observed via telemetry only; NodePilot never executes it.` };
      case 'script':
        return { kind: 'unavailable', code: 'script_unavailable', reason: 'Not configured: custom script execution is unavailable until an isolated runner exists (draft stored only).' };
      case 'none':
        return { kind: 'unavailable', code: 'not_configured', reason: 'Not configured: this node has no implementation.' };
    }
  };
}
