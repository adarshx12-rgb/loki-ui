import path from 'node:path';
import { nodeSchema, RULES_PORT, type NodeKind, type WorkflowEdge, type WorkflowNode } from '@nodepilot/shared';

/**
 * Heuristic repository → initial workflow graph. It never executes the code.
 *
 * Two layouts:
 *  - **structure** (default for most projects): the project's real modules (folders, or files in
 *    flat folders) with arrows following which code uses which. Entry points (API routes, pages,
 *    main/cli) sit on the left, the modules they use to the right, external services (databases,
 *    LLM providers, third-party APIs) last. Nothing is assumed about what the project does.
 *  - **pipeline**: for AI pipelines where file names *and* code clearly show stages
 *    (planner, judge, critic, screener…): I/P → rules → router → planner → discover → [screen]
 *    → inspect → judge → rank → O/P (→ critic).
 *
 * `auto` picks pipeline only on strong evidence. Every node carries code references back to its files.
 */

export interface SourceFile { path: string; content: string }
export type AnalysisMode = 'auto' | 'structure' | 'pipeline';

export interface AnalysisResult {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  stats: { filesScanned: number; filesMatched: number; models: string[]; languages: string[]; mode: 'structure' | 'pipeline'; reason: string; hiddenModules: number };
}

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.swift', '.vue', '.svelte', '.astro']);
const PROMPT_EXT = new Set(['.md', '.txt', '.prompt', '.yaml', '.yml', '.j2', '.jinja', '.hbs', '.mustache']);
/**
 * Folders with no project logic: dependencies, build output, tests and scratch/benchmark runs
 * ("test-results", "bench", "tmp"…), docs, virtualenvs (any name containing "venv") and hidden folders.
 */
const NOISE_DIR = /^(node_modules|dist|build|out|coverage|vendor|__pycache__|target|migrations?|fixtures?|mocks?|__mocks__|__tests__|tests?|testing|specs?|e2e|examples?|docs?|scripts?|public|static|assets|site-packages|bench(marks?)?|harness|tmp|temp|scratch|playground|notebooks?|screenshots?)$/i;
function isNoiseDir(seg: string) {
  // Names like "results" or "reports" can be real features, so only test-flavoured ones ("test-results", "e2e-tests") are skipped.
  return NOISE_DIR.test(seg) || /venv/i.test(seg) || seg.startsWith('.') || /(^|[-_])tests?([-_]|$)/i.test(seg);
}
const inNoiseDir = (p: string) => path.posix.dirname(p).split('/').some((s) => s && s !== '.' && isNoiseDir(s));
const SKIP_FILE = /(\.test\.|\.spec\.|\.d\.ts$|^setup\.|config\.(js|ts|cjs|mjs)$|eslint|prettier|vite|webpack|rollup|jest|vitest)/i;
const COL = 300;
const ROW = 200;

// ------------------------------------------------------------------ shared helpers

// Model ids are lower-case and carry a version number (gemini-3.8-flash, openai/gpt-6-luna, claude-haiku-4.5, kimi-k3).
const MODEL_RE = [
  /\b(?:openai|anthropic|google|mistralai|meta-llama|qwen|deepseek|moonshotai|x-ai|inception|baai|cohere|nvidia|perplexity|amazon)\/[a-z0-9][a-z0-9._:-]{1,60}/g,
  /\b(?:claude|gpt|gemini|gemma|llama|mistral|ministral|mixtral|qwen\d*|kimi|deepseek|whisper|sonnet|haiku|opus)-[a-z0-9][a-z0-9._-]{0,40}/g,
  /\bo[134](?:-mini|-pro)?\b(?=['"`])/g,
];

export function detectModels(text: string): string[] {
  const found = new Set<string>();
  for (const re of MODEL_RE) for (const m of text.matchAll(re)) {
    const v = m[0].replace(/[.\-_:]+$/, '');
    if (v.length >= 2 && /\d/.test(v) && !/-(?:api|key|client|sdk|provider|model|models|config|url|only|specific)$/.test(v)) found.add(v.replace(/:free$/, ''));
  }
  // "gpt-6-luna" is the same model as "openai/gpt-6-luna".
  const qualified = new Set([...found].filter((m) => m.includes('/')).map((m) => m.split('/').pop()));
  return [...found].filter((m) => m.includes('/') || !qualified.has(m));
}

function stem(p: string) {
  return path.posix.basename(p).replace(/\.[^.]+$/, '').toLowerCase();
}

function titleCase(s: string) {
  return s.replace(/[-_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

/**
 * The instruction text a rules node shows. Prompt documents are used as-is; for source
 * files, the longest prose-like string literals are the likely prompts.
 */
export function promptText(file: SourceFile): string {
  if (PROMPT_EXT.has(path.posix.extname(file.path).toLowerCase())) return file.content.slice(0, 4000);
  const literals: string[] = [];
  const re = /`([^`]{80,})`|"""([\s\S]{80,}?)"""|'''([\s\S]{80,}?)'''|"((?:[^"\\\n]|\\.){80,})"|'((?:[^'\\\n]|\\.){80,})'/g;
  for (const m of file.content.matchAll(re)) {
    const text = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim();
    // Prose, not code or data: mostly letters and spaces.
    const letters = (text.match(/[A-Za-z ]/g)?.length ?? 0) / text.length;
    if (letters > 0.75 && text.split(/\s+/).length >= 12) literals.push(text);
  }
  literals.sort((a, b) => b.length - a.length);
  const body = literals.slice(0, 3).join('\n\n---\n\n');
  return (body || `Rules and prompt construction live in ${file.path}.`).slice(0, 4000);
}

/** Local imports → repository paths, plus bare package names. Handles relative imports, "@/…" and "~/…" aliases, and Python packages. */
function importsOf(file: SourceFile, known: Map<string, string>, workspace: Map<string, string>): { local: Set<string>; packages: Set<string> } {
  const local = new Set<string>();
  const packages = new Set<string>();
  const dir = path.posix.dirname(file.path);
  const resolve = (base: string) => {
    const b = path.posix.normalize(base).replace(/\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte)$/, '');
    return known.get(b) ?? known.get(`${b}/index`) ?? known.get(`src/${b}`) ?? known.get(`src/${b}/index`);
  };
  if (/\.(py)$/.test(file.path)) {
    for (const m of file.content.matchAll(/^\s*(?:from\s+(\.*[\w.]*)\s+import|import\s+([\w.]+))/gm)) {
      const spec = m[1] ?? m[2] ?? '';
      if (spec.startsWith('.')) {
        const up = spec.match(/^\.+/)![0].length - 1;
        const base = path.posix.join(dir, ...Array(up).fill('..'), spec.replace(/^\.+/, '').replace(/\./g, '/'));
        const hit = known.get(base) ?? known.get(`${base}/__init__`);
        if (hit) local.add(hit);
      } else if (spec) {
        const asPath = spec.replace(/\./g, '/');
        const hit = known.get(asPath) ?? known.get(`${asPath}/__init__`) ?? known.get(path.posix.join(dir, asPath));
        if (hit) local.add(hit);
        else packages.add(spec.split('.').slice(0, 2).join('.'));
      }
    }
    return { local, packages };
  }
  const re = /(?:import\s[^'"`;]*?from\s*|import\s*\(?\s*|require\(\s*|export\s[^'"`;]*?from\s*)['"]([^'"]+)['"]/g;
  for (const m of file.content.matchAll(re)) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      const hit = resolve(path.posix.join(dir, spec));
      if (hit) local.add(hit);
    } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
      const hit = resolve(spec.slice(2));
      if (hit) local.add(hit);
    } else if (!spec.startsWith('/') && !spec.startsWith('node:')) {
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      // The project's own workspace packages ("@acme/shared", "@acme/shared/node") are local code.
      const wsDir = workspace.get(pkg);
      if (wsDir !== undefined) {
        const sub = spec.slice(pkg.length).replace(/^\//, '');
        const hit = sub
          ? resolve(path.posix.join(wsDir, 'src', sub)) ?? resolve(path.posix.join(wsDir, sub))
          : resolve(path.posix.join(wsDir, 'src', 'index')) ?? resolve(path.posix.join(wsDir, 'index'));
        if (hit) { local.add(hit); continue; }
      }
      packages.add(pkg);
    }
  }
  return { local, packages };
}

interface Prepared {
  /** Every file given (normalised paths), including ones not analysed, e.g. config files holding model ids. */
  all: SourceFile[];
  usable: SourceFile[];
  known: Map<string, string>;
  imports: Map<string, Set<string>>;
  packages: Map<string, Set<string>>;
  models: Map<string, string[]>;
  allModels: Set<string>;
  languages: string[];
}

function prepare(files: SourceFile[]): Prepared {
  // package.json names → folders, so imports between a monorepo's own packages are followed.
  const workspace = new Map<string, string>();
  for (const f of files) {
    const p = f.path.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (path.posix.basename(p) !== 'package.json' || /(^|\/)node_modules\//.test(p)) continue;
    try {
      const name = (JSON.parse(f.content) as { name?: unknown }).name;
      if (typeof name === 'string' && name) workspace.set(name, path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p));
    } catch { /* not JSON */ }
  }
  const all = files.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^\.?\//, '') }));
  const usable = all
    .filter((f) => !inNoiseDir(f.path) && !SKIP_FILE.test(path.posix.basename(f.path)))
    .filter((f) => SOURCE_EXT.has(path.posix.extname(f.path).toLowerCase()) || PROMPT_EXT.has(path.posix.extname(f.path).toLowerCase()));
  const known = new Map<string, string>();
  for (const f of usable) known.set(f.path.replace(/\.[^.]+$/, ''), f.path);
  const imports = new Map<string, Set<string>>();
  const packages = new Map<string, Set<string>>();
  const models = new Map<string, string[]>();
  const allModels = new Set<string>();
  for (const f of usable) {
    const r = importsOf(f, known, workspace);
    imports.set(f.path, r.local);
    packages.set(f.path, r.packages);
    const m = detectModels(f.content);
    models.set(f.path, m);
    m.forEach((x) => allModels.add(x));
  }
  const languages = [...new Set(usable.map((f) => path.posix.extname(f.path).slice(1).toLowerCase()).filter((e) => SOURCE_EXT.has(`.${e}`)))];
  return { all, usable, known, imports, packages, models, allModels, languages };
}

/** Third-party packages and hosts → the external service they represent. */
const EXTERNALS: { re: RegExp; label: string; kind: NodeKind; llm?: boolean }[] = [
  { re: /^@supabase\/|^supabase$/, label: 'Supabase', kind: 'datastore' },
  { re: /^(pg|postgres|@neondatabase\/serverless|@vercel\/postgres|psycopg2?|asyncpg|sqlalchemy)$/, label: 'PostgreSQL', kind: 'datastore' },
  { re: /^(@prisma\/client|prisma)$/, label: 'Database (Prisma)', kind: 'datastore' },
  { re: /^drizzle-orm/, label: 'Database (Drizzle)', kind: 'datastore' },
  { re: /^(mongoose|mongodb|pymongo|motor)$/, label: 'MongoDB', kind: 'datastore' },
  { re: /^(redis|ioredis|@upstash\/redis|aioredis)$/, label: 'Redis', kind: 'datastore' },
  { re: /^(better-sqlite3|sqlite3|sqlite)$/, label: 'SQLite', kind: 'datastore' },
  { re: /^(firebase|firebase-admin|@firebase\/.+)$/, label: 'Firebase', kind: 'datastore' },
  { re: /^(@pinecone-database\/pinecone|pinecone|chromadb|qdrant-client|@qdrant\/js-client-rest|weaviate-client)$/, label: 'Vector database', kind: 'datastore' },
  { re: /^openai$/, label: 'OpenAI', kind: 'api_service', llm: true },
  { re: /^(@anthropic-ai\/sdk|anthropic)$/, label: 'Anthropic', kind: 'api_service', llm: true },
  { re: /^(@google\/genai|@google\/generative-ai|google\.genai|google\.generativeai)$/, label: 'Google Gemini', kind: 'api_service', llm: true },
  { re: /^(groq-sdk|groq)$/, label: 'Groq', kind: 'api_service', llm: true },
  { re: /^ollama$/, label: 'Ollama', kind: 'api_service', llm: true },
  { re: /^(@openrouter\/.+|openrouter)$/, label: 'OpenRouter', kind: 'api_service', llm: true },
  { re: /^(langchain|@langchain\/.+)$/, label: 'LangChain', kind: 'api_service', llm: true },
  { re: /^(ai|@ai-sdk\/.+)$/, label: 'Vercel AI SDK', kind: 'api_service', llm: true },
  // Model weights are downloaded from the Hub; the models themselves run locally (see ML_RUNTIMES).
  { re: /^(@xenova\/transformers|@huggingface\/.+|huggingface_hub)$/, label: 'Hugging Face Hub', kind: 'api_service' },
  { re: /^(youtube-transcript.*|youtube_transcript_api|ytdl-core|@distube\/ytdl-core|yt_dlp|youtubei\.js|youtubei)$/, label: 'YouTube', kind: 'api_service' },
  { re: /^googleapis$/, label: 'Google APIs', kind: 'api_service' },
  { re: /^stripe$/, label: 'Stripe', kind: 'api_service' },
  { re: /^(resend|nodemailer|@sendgrid\/mail)$/, label: 'Email', kind: 'api_service' },
  { re: /^(@aws-sdk\/.+|boto3|aws-sdk)$/, label: 'AWS', kind: 'api_service' },
  { re: /^(@clerk\/.+|next-auth|@auth\/.+)$/, label: 'Auth provider', kind: 'api_service' },
];
const HOST_RE = /https:\/\/((?:api\.)[a-z0-9.-]+\.[a-z]{2,}|[a-z0-9-]+\.supabase\.co|generativelanguage\.googleapis\.com|openrouter\.ai|api\.openai\.com)/g;

function externalFor(pkg: string) {
  return EXTERNALS.find((e) => e.re.test(pkg));
}

// ------------------------------------------------------------------ graph builder

class GraphBuilder {
  nodes: WorkflowNode[] = [];
  edges: WorkflowEdge[] = [];
  private usedIds = new Set<string>();
  private edgeN = 0;
  constructor(readonly serviceId: string) {}

  idFor(base: string) {
    const clean = base.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 50) || 'node';
    let id = `n_${clean}`;
    for (let i = 2; this.usedIds.has(id); i++) id = `n_${clean.slice(0, 46)}_${i}`;
    this.usedIds.add(id);
    return id;
  }

  edge(source: string, sourcePort: string, target: string, targetPort: string) {
    if (source === target || this.edges.some((e) => e.source === source && e.target === target && e.targetPort === targetPort)) return;
    this.edges.push({ id: `e${++this.edgeN}`, source, sourcePort, target, targetPort });
  }

  get observed() {
    return { implementation: { kind: 'observed' as const, serviceId: this.serviceId } };
  }

  uniqueLabel(label: string, hint: string) {
    return this.nodes.some((x) => x.label === label) ? `${label} (${hint})` : label;
  }
}

const IN_PORT = { id: 'in', label: 'In', type: 'any' as const, required: false, multiple: true, merge: 'object_by_source' as const };
const OUT_PORT = { id: 'out', label: 'Out', type: 'json' as const };

// ------------------------------------------------------------------ pipeline layout

type Role = 'rules' | 'router' | 'planner' | 'discover' | 'screen' | 'inspect' | 'judge' | 'rank' | 'critic' | 'store' | 'client';
interface RoleRule { role: Role; kind: NodeKind; re: RegExp; label: string }

/** Order matters: first match wins. Matched against the lower-cased file stem and its parent directory. */
const RULES: RoleRule[] = [
  { role: 'critic', kind: 'judge', re: /critic|audit/, label: 'Critic' },
  { role: 'screen', kind: 'auxiliary', re: /screen|prefilter|pre-?judge|triage|guard|safety/, label: 'Screener' },
  { role: 'judge', kind: 'judge', re: /judge|cascade|council|(^|[-_])review|verif|grader|grading|scorer|evaluator|rerank/, label: 'Judge' },
  { role: 'client', kind: 'api_service', re: /model-?client|openai|anthropic|gemini|llm|provider|ollama|openrouter|completion/, label: 'Model client' },
  { role: 'router', kind: 'router', re: /(^|[-_])router$|routing|dispatch|classif/, label: 'Router' },
  { role: 'rules', kind: 'instruction', re: /prompt|rewrite|rules?$|policy|policies|guideline|instruction|contract|requirement|persona|template/, label: 'Rules' },
  { role: 'planner', kind: 'planner', re: /plan/, label: 'Planner' },
  { role: 'discover', kind: 'scanner', re: /discover|retriev|crawl|scrap|search$|sources?$|fetch|explor|hunt|expansion|ingest|loader|connector/, label: 'Discover' },
  { role: 'inspect', kind: 'worker', re: /scene|caption|transcri|render|extract|inspect|pdf|preview|ocr|moment|whisper|vision|parse|summar|agent|worker|tool/, label: 'Inspect' },
  { role: 'rank', kind: 'aggregator', re: /rank|dedup|duplicate|merge|combin|aggregat|refill|fusion|canonical|corroborat|result/, label: 'Rank' },
  { role: 'store', kind: 'datastore', re: /^db$|database|cache|embedding|vector|store$|queue|repository|memory|index$/, label: 'Store' },
];
/** Generic module names that say nothing about a pipeline stage. */
const GENERIC = /^(config|settings|cli|main|index|app|utils?|helpers?|types?|constants?|common|shared|lib|core|__init__|setup|env|logger|logging|errors?|http|server|page|layout|route)$/;
const STAGE: Partial<Record<Role, number>> = { router: 1, planner: 2, discover: 3, inspect: 4, judge: 5, rank: 6 };
const PIPELINE_ENTRY = /^(main|index|app|server|api|cli|handler|routes?|__main__|wsgi|asgi)$/;
const UI_EXT = /\.(tsx|jsx|vue|svelte)$/;

function classify(file: SourceFile): RoleRule | null {
  const s = stem(file.path);
  const dir = path.posix.basename(path.posix.dirname(file.path)).toLowerCase();
  const ext = path.posix.extname(file.path).toLowerCase();
  if (PROMPT_EXT.has(ext)) {
    // Only prompt-like documents count (README etc. are skipped).
    return /prompt|rules?|policy|instruction|system|persona|template/.test(`${dir}/${s}`) ? RULES.find((r) => r.role === 'rules')! : null;
  }
  // UI components are never pipeline stages ("ResultCard" is not a ranking step).
  if (GENERIC.test(s) || UI_EXT.test(file.path)) return null;
  return RULES.find((r) => r.re.test(s)) ?? RULES.find((r) => r.role !== 'rules' && r.role !== 'store' && r.role !== 'client' && r.re.test(dir)) ?? null;
}

/** Strong evidence of an AI pipeline: ≥2 distinct decision stages named in files that also talk to models. */
function pipelineEvidence(p: Prepared): { yes: boolean; reason: string } {
  const llmFiles = new Set(p.usable.filter((f) => (p.models.get(f.path)?.length ?? 0) > 0 || [...(p.packages.get(f.path) ?? [])].some((k) => externalFor(k)?.llm)).map((f) => f.path));
  const roles = new Set<string>();
  for (const f of p.usable) {
    const r = classify(f);
    if (!r || !['planner', 'judge', 'critic', 'screen'].includes(r.role) || !r.re.test(stem(f.path))) continue;
    // The stage file, or something it imports, must call a model.
    const touchesLlm = llmFiles.has(f.path) || [...(p.imports.get(f.path) ?? [])].some((d) => llmFiles.has(d));
    if (touchesLlm) roles.add(r.label);
  }
  return roles.size >= 2
    ? { yes: true, reason: `AI pipeline stages found in the code: ${[...roles].join(', ')}` }
    : { yes: false, reason: roles.size ? `only one AI stage found (${[...roles][0]}), so the real code structure is shown` : 'no AI pipeline stages found, so the real code structure is shown' };
}

interface Candidate { file: SourceFile; rule: RoleRule; models: string[]; score: number }

function analyzePipeline(p: Prepared, g: GraphBuilder, opts: { projectName: string }) {
  const { usable, imports } = p;
  const importedBy = new Map<string, number>();
  for (const set of imports.values()) for (const x of set) importedBy.set(x, (importedBy.get(x) ?? 0) + 1);

  const byRole = new Map<Role, Candidate[]>();
  for (const f of usable) {
    const rule = classify(f);
    if (!rule) continue;
    const models = p.models.get(f.path) ?? [];
    const score = (models.length ? 3 : 0) + (rule.re.test(stem(f.path)) ? 2 : 0) + Math.min(importedBy.get(f.path) ?? 0, 4) + Math.min(f.content.length / 8000, 2);
    const list = byRole.get(rule.role) ?? [];
    list.push({ file: f, rule, models, score });
    byRole.set(rule.role, list);
  }
  for (const [role, list] of byRole) {
    list.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
    const cap = role === 'store' || role === 'client' ? 6 : role === 'critic' ? 1 : role === 'rules' ? 4 : 6;
    byRole.set(role, list.slice(0, cap));
  }

  const fileOf = new Map<string, string>();
  const make = (c: Candidate, position: { x: number; y: number }): WorkflowNode => {
    const s = stem(c.file.path);
    const id = g.idFor(s);
    fileOf.set(id, c.file.path);
    const kind = c.rule.kind;
    const isInstruction = kind === 'instruction';
    const takesRules = kind === 'planner' || kind === 'worker' || kind === 'judge' || kind === 'scanner' || kind === 'aggregator' || kind === 'router';
    const n = nodeSchema.parse({
      id,
      kind,
      label: g.uniqueLabel(titleCase(s), path.posix.basename(path.posix.dirname(c.file.path)) || 'root').slice(0, 120),
      purpose: `${c.rule.label} stage detected from ${c.file.path}${c.models.length ? `. Models referenced: ${c.models.slice(0, 6).join(', ')}` : ''}.`,
      position,
      inputs: isInstruction || kind === 'api_service' ? [] : kind === 'datastore' ? [{ ...IN_PORT, label: 'Write' }] : takesRules ? [RULES_PORT, IN_PORT] : [IN_PORT],
      outputs: isInstruction ? [{ id: 'rules', label: 'Rules', type: 'rules' }] : [OUT_PORT],
      config: isInstruction ? { implementation: { kind: 'demo', handler: 'instruction' }, params: { models: c.models.slice(0, 8) } } : { ...g.observed, params: { models: c.models.slice(0, 8) } },
      instructions: isInstruction ? promptText(c.file) : '',
      codeRefs: [{ id: 'src', path: c.file.path, note: 'Detected by repository import' }],
    });
    g.nodes.push(n);
    return n;
  };

  const columns: WorkflowNode[][] = [];
  const entryFiles = usable.filter((f) => PIPELINE_ENTRY.test(stem(f.path))).sort((a, b) => a.path.split('/').length - b.path.split('/').length).slice(0, 3);
  const input = nodeSchema.parse({
    id: g.idFor('input'), kind: 'input', label: 'Input', position: { x: 0, y: 0 },
    purpose: `Entry point of ${opts.projectName}${entryFiles.length ? ` (${entryFiles.map((f) => f.path).join(', ')})` : ''}.`,
    outputs: [{ id: 'request', label: 'Request', type: 'text' }],
    config: g.observed,
    codeRefs: entryFiles.map((f, i) => ({ id: `entry${i + 1}`, path: f.path })),
  });
  g.nodes.push(input);
  columns.push([input]);

  for (const [role] of (Object.entries(STAGE) as [Role, number][]).sort((a, b) => a[1] - b[1])) {
    const list = byRole.get(role);
    if (!list?.length) continue;
    const x = columns.length * COL;
    columns.push(list.map((c, i) => make(c, { x, y: (i - (list.length - 1) / 2) * ROW })));
  }

  const output = nodeSchema.parse({
    id: g.idFor('output'), kind: 'output', label: 'Output', position: { x: columns.length * COL, y: 0 },
    purpose: 'Final results returned to the user.',
    inputs: [{ id: 'in', label: 'In', type: 'any', multiple: true, merge: 'object_by_source' }],
    config: g.observed,
  });
  g.nodes.push(output);
  columns.push([output]);

  // Connect consecutive columns, preferring real import relationships between the two stages.
  for (let k = 0; k + 1 < columns.length; k++) {
    const A = columns[k];
    const B = columns[k + 1];
    const related = (a: WorkflowNode, b: WorkflowNode) => {
      const fa = fileOf.get(a.id);
      const fb = fileOf.get(b.id);
      return !!fa && !!fb && (imports.get(fa)?.has(fb) || imports.get(fb)?.has(fa));
    };
    const pairs: [WorkflowNode, WorkflowNode][] = [];
    if (A.length === 1 || B.length === 1 || A.length * B.length <= 4) for (const a of A) for (const b of B) pairs.push([a, b]);
    else {
      for (const a of A) for (const b of B) if (related(a, b)) pairs.push([a, b]);
      for (const a of A) if (!pairs.some(([x]) => x === a)) pairs.push([a, B[0]]);
      for (const b of B) if (!pairs.some(([, y]) => y === b)) pairs.push([A[0], b]);
    }
    for (const [a, b] of pairs) g.edge(a.id, a.outputs[0].id, b.id, 'in');
  }
  orderColumns(columns, g.edges);

  const mainNodes = columns.flat();
  const top = (col: WorkflowNode[]) => Math.min(...col.map((n) => n.position.y));
  const bottom = (col: WorkflowNode[]) => Math.max(...col.map((n) => n.position.y));
  const takesRules = (n: WorkflowNode) => n.inputs.some((x) => x.id === 'rules');

  // Rules (parallelograms) above the node they most likely govern.
  const aboveCount = new Map<number, number>();
  for (const c of byRole.get('rules') ?? []) {
    const f = c.file.path;
    const target = mainNodes.find((n) => fileOf.has(n.id) && imports.get(fileOf.get(n.id)!)?.has(f) && takesRules(n))
      ?? mainNodes.find((n) => takesRules(n) && (n.kind === 'router' || n.kind === 'planner'))
      ?? mainNodes.find(takesRules);
    const colIdx = target ? columns.findIndex((col) => col.includes(target)) : 1;
    const stack = aboveCount.get(colIdx) ?? 0;
    aboveCount.set(colIdx, stack + 1);
    const n = make(c, { x: (target?.position.x ?? COL) + 10, y: (target ? top(columns[colIdx]) : 0) - 170 - stack * 110 });
    if (target) g.edge(n.id, 'rules', target.id, 'rules');
  }

  // Screeners (dashed side branches) off the node feeding judgement.
  const judgeCol = columns.find((col) => col[0].kind === 'judge');
  const anchorCol = judgeCol ? columns[columns.indexOf(judgeCol) - 1] : columns[Math.max(1, columns.length - 2)];
  (byRole.get('screen') ?? []).forEach((c, i) => {
    const anchor = anchorCol[0];
    const y = i % 2 === 0 ? top(anchorCol) - 170 - Math.floor(i / 2) * 120 : bottom(anchorCol) + 170 + Math.floor(i / 2) * 120;
    const n = make(c, { x: anchor.position.x + 20, y });
    g.edge(anchor.id, anchor.outputs[0].id, n.id, 'in');
  });

  // Critic after the output.
  for (const c of byRole.get('critic') ?? []) {
    const feeder = columns[columns.length - 2][0];
    const n = make(c, { x: output.position.x + 30, y: -200 });
    g.edge(feeder.id, feeder.outputs[0].id, n.id, 'in');
  }

  // Judge ensemble container.
  if (judgeCol && judgeCol.length >= 2) {
    const minY = top(judgeCol) - 60;
    const maxY = bottom(judgeCol) + 210;
    g.nodes.unshift(nodeSchema.parse({
      id: g.idFor('judges'), kind: 'group', label: 'Judges', position: { x: judgeCol[0].position.x - 25, y: minY },
      display: { width: 280, height: Math.round(maxY - minY) },
      purpose: 'Judge ensemble detected from multiple judge/review modules.',
      config: { implementation: { kind: 'none' } },
    }));
  }

  // Side row: data stores and model clients.
  const sideY = Math.max(...g.nodes.map((n) => n.position.y)) + 260;
  [...(byRole.get('store') ?? []), ...(byRole.get('client') ?? [])].forEach((c, i) => {
    const users = mainNodes.filter((m) => {
      const f = fileOf.get(m.id);
      return f && imports.get(f)?.has(c.file.path) && m.inputs.some((x) => x.id === 'in');
    });
    const n = make(c, { x: COL + (i % 6) * COL, y: sideY + Math.floor(i / 6) * ROW });
    if (users.length <= 3) for (const m of users) g.edge(n.id, 'out', m.id, 'in');
    else n.purpose += ` Shared by ${users.length} stages: ${users.map((m) => m.label).join(', ')}.`;
  });
  return 0;
}

/** One barycenter sweep: order each column by the mean row of its predecessors, then re-space it. */
function orderColumns(columns: WorkflowNode[][], edges: WorkflowEdge[]) {
  for (let k = 1; k < columns.length; k++) {
    const prevRow = new Map(columns[k - 1].map((n, i) => [n.id, i]));
    const bary = (n: WorkflowNode) => {
      const rows = edges.filter((e) => e.target === n.id && prevRow.has(e.source)).map((e) => prevRow.get(e.source)!);
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.MAX_SAFE_INTEGER;
    };
    const col = columns[k];
    const keyed = col.map((n, i) => ({ n, b: bary(n), i }));
    keyed.sort((x, y) => x.b - y.b || x.i - y.i);
    keyed.forEach(({ n }, i) => { n.position = { x: n.position.x, y: (i - (col.length - 1) / 2) * ROW }; });
    columns[k] = keyed.map(({ n }) => n);
  }
}

// ------------------------------------------------------------------ structure layout

interface Unit {
  key: string;
  files: SourceFile[];
  label: string;
  kind: NodeKind;
  entry: boolean;
  models: string[];
  externals: Set<string>;
  score: number;
}

const API_PATH = /(^|\/)(api|routes?|controllers?|handlers?|endpoints?)(\/|$)/;
const ENTRY_STEM = /^(route|main|server|app|cli|__main__|manage|wsgi|asgi|handler|lambda|worker|bot)$/;
const STORE_NAME = /^(db|database|supabase|prisma|repositor(y|ies)|repo|storage|cache|redis|queue|store|stores|persistence|dal|models?)$/;
const UI_PATH = /(^|\/)(components?|app|pages|views?|ui|screens?|layouts?|widgets?)(\/|$)/;
const MAX_UNITS = 26;
const MAX_EXTERNALS = 8;

/** Folders that only hold code and say nothing about it: "apps/server/src" is just "Server". */
const STRUCTURAL = /^(src|lib|apps|packages|pkg|source|internal|cmd|code|modules)$/;
const isStructuralOnly = (key: string) => key.split('/').every((s) => !s || s === '.' || STRUCTURAL.test(s));

/** Libraries that run a model in-process (browser or machine). A file importing one of these *is* a model. */
const ML_RUNTIMES: { re: RegExp; label: string }[] = [
  { re: /^onnxruntime(-web|-node|-react-native|-gpu)?$/, label: 'ONNX Runtime' },
  { re: /^@tensorflow\/tfjs/, label: 'TensorFlow.js' },
  { re: /^(@huggingface\/transformers|@xenova\/transformers)$/, label: 'Transformers.js' },
  { re: /^@mediapipe\//, label: 'MediaPipe' },
  { re: /^@mlc-ai\/web-llm$/, label: 'WebLLM' },
  { re: /^(node-llama-cpp|llama_cpp|llama-cpp-python)$/, label: 'llama.cpp' },
  { re: /^(torch|torchvision|torchaudio)$/, label: 'PyTorch' },
  { re: /^(tensorflow|keras|tf_keras)$/, label: 'TensorFlow' },
  { re: /^transformers$/, label: 'Transformers' },
  { re: /^diffusers$/, label: 'Diffusers' },
  { re: /^ultralytics$/, label: 'Ultralytics YOLO' },
  { re: /^(mlx|mlx_lm|mlx\.core)$/, label: 'MLX' },
  { re: /^(whisper|faster_whisper)$/, label: 'Whisper' },
];
/** Support code that lives next to models but is not one. */
const MODEL_HELPER = /^(index|types?|errors?|utils?|helpers?|config|constants?|base|common|registry|loader|cache|cached.*|.*fix|.*shader.*|saved.*|.*-?utils?)$/i;
const MODEL_FOLDER = /^(models?|ml|inference|ai|weights|nets?|networks?|matting|segmentation)$/i;

function modelRuntime(f: SourceFile, p: Prepared): string | undefined {
  if (MODEL_HELPER.test(stem(f.path))) return undefined;
  for (const pkg of p.packages.get(f.path) ?? []) {
    const r = ML_RUNTIMES.find((x) => x.re.test(pkg));
    if (r) return r.label;
  }
  return /\bInferenceSession\b|\bloadGraphModel\b|\bloadLayersModel\b|\.from_pretrained\(/.test(f.content) ? 'model' : undefined;
}

/** "ben2" → "BEN2", "rvm" → "RVM"; longer names keep their own spelling ("withoutbg"). */
const modelName = (s: string) => (/^[a-z]{2,4}\d{0,2}$/i.test(s) ? s.toUpperCase() : s);

/** Model source mentioned for a model file: a Hugging Face repo or a model URL from the constants it imports. */
function modelSource(f: SourceFile, all: SourceFile[]): string | undefined {
  const direct = f.content.match(/huggingface\.co\/([\w.-]+\/[\w.-]+)|['"]([\w.-]+\/[\w.-]+-onnx)['"]/i);
  if (direct) return direct[1] ?? direct[2];
  for (const id of new Set(f.content.match(/\b[A-Z][A-Z0-9_]*MODEL[A-Z0-9_]*\b/g) ?? [])) {
    for (const other of all) {
      const at = other.content.search(new RegExp(`\\b${id}\\s*[:=]`));
      if (at < 0) continue;
      const block = other.content.slice(at, at + 700);
      const m = block.match(/repo\s*:\s*['"`]([^'"`]+)['"`]/) ?? block.match(/huggingface\.co\/([\w.-]+\/[\w.-]+)/) ?? block.match(/github\.com\/([\w.-]+\/[\w.-]+)/);
      if (m) return m[1];
    }
  }
  return undefined;
}

/** What goes in and what comes out, from upload `accept` lists and the formats the code writes. */
function ioFormats(files: SourceFile[]) {
  const input = new Set<string>();
  const output = new Set<string>();
  const producers = new Set<string>();
  const add = (set: Set<string>, token: string) => {
    const t = token.trim().toLowerCase();
    if (!t) return;
    if (t.startsWith('.')) set.add(t.slice(1));
    else if (t.endsWith('/*')) set.add(t.slice(0, -2));
    else if (t.includes('/')) set.add(t.split('/')[1].replace(/^x-/, '').replace('quicktime', 'mov').replace('jpeg', 'jpg'));
  };
  for (const f of files) {
    for (const m of f.content.matchAll(/accept\s*=\s*\{?\s*["'`]([^"'`]+)["'`]/g)) m[1].split(',').forEach((t) => add(input, t));
    let wrote = false;
    for (const m of f.content.matchAll(/mimeType\s*:\s*['"`]((?:video|audio|image)\/[\w.+-]+)/g)) { add(output, m[1]); wrote = true; }
    for (const m of f.content.matchAll(/to(?:Blob|DataURL)\([^)]*?['"`](image\/[\w+-]+)['"`]/g)) { add(output, m[1]); wrote = true; }
    for (const m of f.content.matchAll(/download\s*=\s*\{?\s*[`'"][^`'"\n]*?\.(mp4|webm|mov|mkv|gif|png|jpe?g|webp|wav|mp3|json|csv|pdf|zip|txt)[`'"]/g)) { output.add(m[1].replace('jpeg', 'jpg')); wrote = true; }
    if (/\bdownload=|\.download\s*=|new MediaRecorder\(/.test(f.content)) wrote = true;
    if (wrote) producers.add(f.path);
  }
  // "video" next to "mp4, mov…" says nothing extra.
  const tidy = (set: Set<string>) => {
    const list = [...set];
    const hasVideo = list.some((x) => ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(x));
    const hasImage = list.some((x) => ['png', 'jpg', 'webp', 'gif'].includes(x));
    // Video first, then audio, documents/data, images last.
    const rank = (x: string) => (['mp4', 'mov', 'webm', 'mkv', 'avi', 'video'].includes(x) ? 0 : ['wav', 'mp3', 'audio'].includes(x) ? 1 : ['png', 'jpg', 'webp', 'gif', 'image'].includes(x) ? 3 : 2);
    return list
      .filter((x) => !(x === 'video' && hasVideo) && !(x === 'image' && hasImage))
      .sort((a, b) => rank(a) - rank(b))
      .map((x) => (x === 'image' ? 'images' : x));
  };
  return { input: tidy(input), output: tidy(output), producers };
}

function unitLabel(key: string, isFile: boolean): string {
  const all = key.split('/').filter((s) => s && !/^\(.*\)$/.test(s)); // drop Next.js route groups like (dashboard)
  const meaningful = all.filter((s, i) => !STRUCTURAL.test(s) || (isFile && i === all.length - 1));
  const segs = meaningful.length ? meaningful : all;
  if (!segs.length) return 'Root';
  const pretty = (s: string) => (/^\[.*\]$/.test(s) ? `:${s.slice(1, -1)}` : titleCase(isFile ? s.replace(/\.[^.]+$/, '') : s));
  const last = segs[segs.length - 1];
  if (isFile) return pretty(last);
  if (segs.includes('api') && last !== 'api') return `${pretty(segs.slice(segs.indexOf('api') + 1).join(' '))} API`;
  if (segs.length >= 2) return `${pretty(last)} (${segs[segs.length - 2]})`;
  return pretty(last);
}

function analyzeStructure(p: Prepared, g: GraphBuilder, opts: { projectName: string }): number {
  const sources = p.usable.filter((f) => SOURCE_EXT.has(path.posix.extname(f.path).toLowerCase()));
  const prompts = p.usable.filter((f) => PROMPT_EXT.has(path.posix.extname(f.path).toLowerCase()) && classify(f)?.role === 'rules').slice(0, 3);
  if (!sources.length) return 0;

  // 1. Units: one per folder; a folder holding a large share of the project is split into its files.
  const dirOf = (f: SourceFile) => path.posix.dirname(f.path);
  const perDir = new Map<string, number>();
  for (const f of sources) perDir.set(dirOf(f), (perDir.get(dirOf(f)) ?? 0) + 1);
  const splitDir = (d: string) => d === '.' || ((perDir.get(d) ?? 0) > 8 && (perDir.get(d) ?? 0) > sources.length * 0.3);
  const dirsLower = new Map([...perDir.keys()].map((d) => [d.toLowerCase(), d]));
  const fileImportedBy = new Map<string, number>();
  for (const set of p.imports.values()) for (const x of set) fileImportedBy.set(x, (fileImportedBy.get(x) ?? 0) + 1);
  const unitKeyOf = new Map<string, string>();
  const units = new Map<string, Unit>();
  for (const f of sources) {
    const d = dirOf(f);
    // "Studio.tsx" next to a "studio/" folder is one thing: the Studio.
    const twin = dirsLower.get(path.posix.join(d, stem(f.path)).toLowerCase());
    const isFile = !(twin && !splitDir(twin)) && splitDir(d);
    const key = twin && !splitDir(twin) ? twin : isFile ? f.path : d;
    unitKeyOf.set(f.path, key);
    let u = units.get(key);
    if (!u) {
      u = { key, files: [], label: unitLabel(key, isFile), kind: 'module', entry: false, models: [], externals: new Set(), score: 0 };
      units.set(key, u);
    }
    u.files.push(f);
  }
  for (const u of units.values()) {
    const base = path.posix.basename(u.key).toLowerCase();
    const twinFile = u.files.find((f) => path.posix.dirname(f.path) !== u.key && stem(f.path) === base);
    if (twinFile) u.label = titleCase(path.posix.basename(twinFile.path).replace(/\.[^.]+$/, ''));
    // "src/lib" says nothing; name it after its most-used files instead.
    else if (u.files.length > 1 && isStructuralOnly(u.key)) {
      u.label = [...u.files].sort((a, b) => (fileImportedBy.get(b.path) ?? 0) - (fileImportedBy.get(a.path) ?? 0)).slice(0, 2).map((f) => titleCase(path.posix.basename(f.path).replace(/\.[^.]+$/, ''))).join(' · ');
    }
  }

  // 1b. Models the project runs itself: each model file is its own box (grouped later); the helpers beside them are folded away.
  const modelUnits = new Map<string, { runtime: string; source?: string }>();
  const supportUnits = new Set<string>();
  for (const u of [...units.values()]) {
    const found = u.files.map((f) => ({ f, runtime: modelRuntime(f, p) })).filter((x) => x.runtime);
    if (!found.length) continue;
    for (const { f, runtime } of found) {
      const key = f.path;
      if (key !== u.key) units.set(key, { key, files: [f], label: modelName(stem(f.path)), kind: 'model', entry: false, models: [], externals: new Set(), score: 0 });
      else u.label = modelName(stem(f.path));
      unitKeyOf.set(f.path, key);
      modelUnits.set(key, { runtime: runtime!, source: modelSource(f, p.all) });
    }
    if (u.key !== found[0].f.path) {
      u.files = u.files.filter((f) => !found.some((x) => x.f === f));
      if (!u.files.length) units.delete(u.key);
      else if (MODEL_FOLDER.test(path.posix.basename(u.key))) supportUnits.add(u.key);
    }
  }

  // 2. Unit → unit and unit → external usage.
  const uses = new Map<string, Set<string>>();
  const extUse = new Map<string, Set<string>>(); // external label → unit keys
  const extMeta = new Map<string, { kind: NodeKind; llm: boolean }>();
  for (const f of sources) {
    const from = unitKeyOf.get(f.path)!;
    for (const dep of p.imports.get(f.path) ?? []) {
      const to = unitKeyOf.get(dep);
      if (to && to !== from) (uses.get(from) ?? uses.set(from, new Set()).get(from)!).add(to);
    }
    const exts = new Set<string>();
    for (const pkg of p.packages.get(f.path) ?? []) {
      const e = externalFor(pkg);
      if (e) { exts.add(e.label); extMeta.set(e.label, { kind: e.kind, llm: !!e.llm }); }
    }
    for (const m of f.content.matchAll(HOST_RE)) {
      const host = m[1];
      const known = /supabase\.co$/.test(host) ? 'Supabase' : /openrouter\.ai$/.test(host) ? 'OpenRouter' : /generativelanguage/.test(host) ? 'Google Gemini' : /api\.openai\.com/.test(host) ? 'OpenAI' : /api\.anthropic\.com/.test(host) ? 'Anthropic' : /api\.github\.com/.test(host) ? 'GitHub' : host;
      exts.add(known);
      if (!extMeta.has(known)) extMeta.set(known, { kind: known === 'Supabase' ? 'datastore' : 'api_service', llm: ['OpenRouter', 'Google Gemini', 'OpenAI', 'Anthropic'].includes(known) });
    }
    for (const e of exts) {
      units.get(from)!.externals.add(e);
      (extUse.get(e) ?? extUse.set(e, new Set()).get(e)!).add(from);
    }
  }

  // 3. What each unit is, from its own path and code only.
  const importedBy = new Map<string, number>();
  for (const set of uses.values()) for (const k of set) importedBy.set(k, (importedBy.get(k) ?? 0) + 1);
  for (const u of units.values()) {
    const model = modelUnits.get(u.key);
    if (model) {
      // Chips: how it runs, and where the weights come from.
      u.kind = 'model';
      u.models = [model.runtime, ...(model.source ? [model.source] : []), ...(p.models.get(u.files[0].path) ?? [])].filter((x, i, a) => x !== 'model' && a.indexOf(x) === i);
      u.score = 20;
      continue;
    }
    const isFileUnit = u.files.length === 1 && u.key === u.files[0].path;
    const name = isFileUnit ? stem(u.key) : path.posix.basename(u.key).toLowerCase();
    u.models = [...new Set(u.files.flatMap((f) => p.models.get(f.path) ?? []))];
    const usesLlm = u.models.length > 0 || [...u.externals].some((e) => extMeta.get(e)?.llm);
    const uiShare = u.files.filter((f) => UI_EXT.test(f.path)).length / u.files.length;
    const isApi = API_PATH.test(u.key) || u.files.some((f) => stem(f.path) === 'route');
    const isPage = u.files.some((f) => /^(page|index)$/.test(stem(f.path)) && UI_EXT.test(f.path) && /(^|\/)(app|pages)(\/|$)/.test(f.path));
    const role = isFileUnit ? RULES.find((r) => ['planner', 'judge', 'critic', 'screen', 'router'].includes(r.role) && r.re.test(name)) : undefined;
    if (/^prompts?$/.test(name)) u.kind = 'instruction';
    else if (STORE_NAME.test(name) && !isPage) u.kind = 'datastore';
    else if (isApi) u.kind = usesLlm ? 'model' : 'module';
    else if (uiShare > 0.5 && (UI_PATH.test(u.key) || isPage)) u.kind = 'ui';
    else if (role && usesLlm) u.kind = role.kind;
    else if (usesLlm) u.kind = 'model';
    else u.kind = 'module';
    u.entry = isApi || isPage
      || (!importedBy.get(u.key) && u.files.some((f) => ENTRY_STEM.test(stem(f.path)) || stem(f.path) === 'index'))
      // A screen nothing else imports is where people start (its page may be .html/.astro outside the scan).
      || (u.kind === 'ui' && !importedBy.get(u.key));
    if (isApi && !/api$/i.test(u.label) && u.kind !== 'instruction') u.label = `${u.label} API`;
    u.score = (u.entry ? 4 : 0) + (usesLlm ? 4 : 0) + Math.log2(1 + u.files.length) + Math.min(importedBy.get(u.key) ?? 0, 5) + Math.min(uses.get(u.key)?.size ?? 0, 3) + u.externals.size;
  }

  // 4. Keep the most important units; bridge edges through the ones left out.
  const ranked = [...units.values()].filter((u) => !supportUnits.has(u.key)).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const kept = new Set(ranked.slice(0, MAX_UNITS).map((u) => u.key));
  const hidden = units.size - kept.size;
  const keptUses = new Map<string, Set<string>>();
  for (const k of kept) {
    const out = new Set<string>();
    const seen = new Set<string>([k]);
    const stack = [...(uses.get(k) ?? [])];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      if (kept.has(x)) out.add(x);
      else stack.push(...(uses.get(x) ?? []));
    }
    keptUses.set(k, out);
  }
  // Externals reached only through hidden units still belong to the kept unit that leads there.
  const externals = [...extUse.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, MAX_EXTERNALS).map(([e]) => e);

  // 5. Break import cycles (keep edges in DFS tree/forward order from entry points).
  const order = [...kept].sort((a, b) => Number(units.get(b)!.entry) - Number(units.get(a)!.entry) || units.get(b)!.score - units.get(a)!.score);
  const state = new Map<string, 0 | 1 | 2>();
  const dag = new Map<string, Set<string>>([...kept].map((k) => [k, new Set<string>()]));
  const visit = (k: string) => {
    state.set(k, 1);
    for (const t of keptUses.get(k) ?? []) {
      const s = state.get(t) ?? 0;
      if (s === 1) continue; // back edge → would close a cycle
      dag.get(k)!.add(t);
      if (s === 0) visit(t);
    }
    state.set(k, 2);
  };
  for (const k of order) if (!state.get(k)) visit(k);

  // 6. Layers: entry points first, then longest path along "uses".
  const layer = new Map<string, number>();
  const indeg = new Map<string, number>([...kept].map((k) => [k, 0]));
  for (const ts of dag.values()) for (const t of ts) indeg.set(t, (indeg.get(t) ?? 0) + 1);
  const queue = [...kept].filter((k) => indeg.get(k) === 0);
  for (const k of queue) layer.set(k, 1);
  while (queue.length) {
    const k = queue.shift()!;
    for (const t of dag.get(k)!) {
      layer.set(t, Math.max(layer.get(t) ?? 1, (layer.get(k) ?? 1) + 1));
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  // Models get a column of their own, so they read as one stage (and fit in one group box).
  const modelKeys = [...kept].filter((k) => modelUnits.has(k));
  if (modelKeys.length) {
    const L = Math.min(...modelKeys.map((k) => layer.get(k) ?? 1));
    for (const k of kept) if (!modelUnits.has(k) && (layer.get(k) ?? 1) >= L) layer.set(k, (layer.get(k) ?? 1) + 1);
    for (const k of modelKeys) layer.set(k, L);
  }
  const maxLayer = Math.max(1, ...layer.values());

  // 7. Nodes.
  const io = ioFormats(sources);
  const nodeOf = new Map<string, WorkflowNode>();
  const columns: WorkflowNode[][] = [];
  const entries = [...kept].filter((k) => units.get(k)!.entry);
  const input = nodeSchema.parse({
    id: g.idFor('input'), kind: 'input', label: io.input.length ? io.input.join(' · ') : 'Requests', position: { x: 0, y: 0 },
    purpose: `${io.input.length ? `Accepts: ${io.input.join(', ')}. ` : ''}Where work enters ${opts.projectName}${entries.length ? `: ${entries.map((k) => units.get(k)!.label).join(', ')}` : ''}.`,
    outputs: [{ id: 'request', label: 'Request', type: 'text' }],
    config: g.observed,
  });
  g.nodes.push(input);
  columns.push([input]);
  for (let l = 1; l <= maxLayer; l++) {
    const col: WorkflowNode[] = [];
    for (const k of order.filter((x) => layer.get(x) === l)) {
      const u = units.get(k)!;
      const isInstruction = u.kind === 'instruction';
      const n = nodeSchema.parse({
        id: g.idFor(u.label.toLowerCase()),
        kind: u.kind,
        label: g.uniqueLabel(u.label, u.key).slice(0, 120),
        purpose: `${u.files.length === 1 ? u.files[0].path : `${u.key}/ (${u.files.length} files)`}${u.externals.size ? `. Uses: ${[...u.externals].join(', ')}` : ''}${u.models.length ? `. Models: ${u.models.slice(0, 6).join(', ')}` : ''}.`,
        position: { x: l * COL, y: 0 },
        inputs: isInstruction ? [] : u.kind === 'model' ? [RULES_PORT, IN_PORT] : [IN_PORT],
        outputs: isInstruction ? [{ id: 'rules', label: 'Rules', type: 'rules' }] : [OUT_PORT],
        config: isInstruction ? { implementation: { kind: 'demo', handler: 'instruction' } } : { ...g.observed, params: { models: u.models.slice(0, 8) } },
        instructions: isInstruction ? promptText(u.files[0]) : '',
        codeRefs: u.files.slice(0, 8).map((f, i) => ({ id: `src${i + 1}`, path: f.path })),
      });
      nodeOf.set(k, n);
      g.nodes.push(n);
      col.push(n);
    }
    columns.push(col);
  }
  for (const k of entries) g.edge(input.id, 'request', nodeOf.get(k)!.id, 'in');
  if (!entries.length) for (const k of [...kept].filter((x) => layer.get(x) === 1)) g.edge(input.id, 'request', nodeOf.get(k)!.id, 'in');
  for (const [k, ts] of dag) for (const t of ts) {
    const a = nodeOf.get(k)!;
    const b = nodeOf.get(t)!;
    if (b.kind === 'instruction') g.edge(b.id, 'rules', a.id, a.inputs.some((x) => x.id === 'rules') ? 'rules' : 'in');
    else if (a.kind !== 'instruction') g.edge(a.id, 'out', b.id, 'in');
  }

  // What comes out, fed by the code that writes files / recordings / downloads.
  const keptParent = (unitKey: string) => (kept.has(unitKey) ? [unitKey] : [...kept].filter((x) => [...(uses.get(x) ?? [])].includes(unitKey)));
  const producerUnits = new Set([...io.producers].flatMap((f) => keptParent(unitKeyOf.get(f) ?? '')));
  let outCol = 0;
  if (io.output.length || producerUnits.size) {
    outCol = maxLayer + 1;
    const output = nodeSchema.parse({
      id: g.idFor('output'), kind: 'output', label: io.output.length ? io.output.join(' · ') : 'Output', position: { x: outCol * COL, y: 0 },
      purpose: `${io.output.length ? `Produces: ${io.output.join(', ')}. ` : ''}Written by ${[...producerUnits].map((k) => units.get(k)?.label ?? k).join(', ') || 'the project'}.`,
      inputs: [{ id: 'in', label: 'In', type: 'any', required: false, multiple: true, merge: 'object_by_source' }],
      config: g.observed,
    });
    g.nodes.push(output);
    columns.push([output]);
    for (const k of producerUnits) g.edge(nodeOf.get(k)!.id, 'out', output.id, 'in');
  }

  // External services in the last column, fed by the units that use them.
  const extCol: WorkflowNode[] = [];
  for (const e of externals) {
    const meta = extMeta.get(e)!;
    const n = nodeSchema.parse({
      id: g.idFor(e.toLowerCase()),
      kind: meta.kind,
      label: g.uniqueLabel(e, 'external'),
      purpose: `External ${meta.kind === 'datastore' ? 'data store' : meta.llm ? 'model provider' : 'service'} used by ${[...(extUse.get(e) ?? [])].map((k) => units.get(k)?.label ?? k).slice(0, 6).join(', ')}.`,
      position: { x: (Math.max(maxLayer, outCol) + 1) * COL, y: 0 },
      inputs: [{ ...IN_PORT, label: meta.kind === 'datastore' ? 'Read / write' : 'Calls' }],
      outputs: [OUT_PORT],
      config: g.observed,
    });
    g.nodes.push(n);
    extCol.push(n);
    // A hidden unit's calls are drawn from the kept unit that leads to it.
    for (const k of extUse.get(e) ?? []) for (const f of keptParent(k)) g.edge(nodeOf.get(f)!.id, 'out', n.id, 'in');
  }
  if (extCol.length) columns.push(extCol);

  // Prompt documents (rules) attached to the first unit that talks to a model.
  const llmNode = g.nodes.find((n) => n.inputs.some((x) => x.id === 'rules'));
  prompts.forEach((f, i) => {
    const n = nodeSchema.parse({
      id: g.idFor(stem(f.path)), kind: 'instruction', label: g.uniqueLabel(titleCase(stem(f.path)), 'prompt'),
      purpose: `Prompt / rules document ${f.path}.`, position: { x: (llmNode?.position.x ?? COL) + 10, y: -400 - i * 110 },
      outputs: [{ id: 'rules', label: 'Rules', type: 'rules' }],
      config: { implementation: { kind: 'demo', handler: 'instruction' } },
      instructions: promptText(f),
      codeRefs: [{ id: 'src', path: f.path }],
    });
    g.nodes.push(n);
    if (llmNode) g.edge(n.id, 'rules', llmNode.id, 'rules');
  });

  for (const col of columns) col.forEach((n, i) => { n.position = { x: n.position.x, y: (i - (col.length - 1) / 2) * ROW }; });
  orderColumns(columns, g.edges);
  // Prompts sit just above the column of the node they feed.
  if (llmNode) {
    const col = columns.find((c) => c.includes(llmNode))!;
    const top = Math.min(...col.map((n) => n.position.y));
    g.nodes.filter((n) => n.kind === 'instruction' && !col.includes(n)).forEach((n, i) => { n.position = { x: llmNode.position.x + 10, y: top - 170 - i * 110 }; });
  }

  // One box around the models, like an ensemble.
  const modelNodes = modelKeys.map((k) => nodeOf.get(k)!).filter(Boolean);
  if (modelNodes.length >= 2) {
    const ys = modelNodes.map((n) => n.position.y);
    const minY = Math.min(...ys) - 60;
    const maxY = Math.max(...ys) + 210;
    g.nodes.unshift(nodeSchema.parse({
      id: g.idFor('models_group'), kind: 'group', label: 'Local models', position: { x: modelNodes[0].position.x - 25, y: minY },
      display: { width: 290, height: Math.round(maxY - minY) },
      purpose: `Models the project runs itself: ${modelNodes.map((n) => n.label).join(', ')}.`,
      config: { implementation: { kind: 'none' } },
    }));
  }
  return hidden;
}

// ------------------------------------------------------------------ entry point

export function analyzeRepository(files: SourceFile[], opts: { serviceId: string; projectName: string; mode?: AnalysisMode }): AnalysisResult {
  const p = prepare(files);
  const g = new GraphBuilder(opts.serviceId);
  const evidence = pipelineEvidence(p);
  const mode = opts.mode === 'pipeline' || (opts.mode !== 'structure' && evidence.yes) ? 'pipeline' : 'structure';
  const reason = opts.mode === 'pipeline' ? 'AI pipeline layout chosen at import' : opts.mode === 'structure' ? 'code structure layout chosen at import' : evidence.reason;
  const hiddenModules = mode === 'pipeline' ? analyzePipeline(p, g, opts) : analyzeStructure(p, g, opts);
  return {
    nodes: g.nodes,
    edges: g.edges,
    stats: {
      filesScanned: p.usable.length,
      filesMatched: g.nodes.filter((n) => n.codeRefs.length).length,
      models: [...p.allModels].slice(0, 60),
      languages: p.languages,
      mode,
      reason,
      hiddenModules,
    },
  };
}
