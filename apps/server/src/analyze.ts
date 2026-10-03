import path from 'node:path';
import { nodeSchema, RULES_PORT, type NodeKind, type WorkflowEdge, type WorkflowNode } from '@nodepilot/shared';

/**
 * Heuristic repository → initial workflow graph.
 *
 * It does not execute or understand the code. It classifies source files by name
 * (and a few content signals) into pipeline stages, picks up model identifiers that
 * appear in each file, and lays the stages out left → right:
 *
 *   I/P → rules → router → planner → discover → [screen] → inspect → judge → rank → O/P (→ critic)
 *
 * Data stores and model clients become side nodes. Everything is a starting point the
 * user is expected to edit; every node carries a code reference to its source file.
 */

export interface SourceFile { path: string; content: string }

export interface AnalysisResult {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  stats: { filesScanned: number; filesMatched: number; models: string[]; languages: string[] };
}

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
const GENERIC = /^(config|settings|cli|main|index|app|utils?|helpers?|types?|constants?|common|shared|lib|core|__init__|setup|env|logger|logging|errors?|http|server)$/;

/** Left → right column for each main-line role. */
const STAGE: Partial<Record<Role, number>> = { router: 1, planner: 2, discover: 3, inspect: 4, judge: 5, rank: 6 };

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.swift']);
const PROMPT_EXT = new Set(['.md', '.txt', '.prompt', '.yaml', '.yml', '.j2', '.jinja', '.hbs', '.mustache']);
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|out|coverage|vendor|venv|\.venv|__pycache__|\.next|target|migrations?|fixtures?|__tests__|tests?|spec|e2e|examples?|docs?|scripts?|public|static|assets)(\/|$)/i;
const SKIP_FILE = /(\.test\.|\.spec\.|\.d\.ts$|^setup\.|config\.(js|ts|cjs|mjs)$|eslint|prettier|vite|webpack|rollup|jest|vitest)/i;
const ENTRY = /^(main|index|app|server|api|cli|handler|routes?|__main__|wsgi|asgi)$/;

const MAX_PER_STAGE = 6;
const MAX_SIDE = 6;
const COL = 300;
const ROW = 200;

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
  return s.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function classify(file: SourceFile): RoleRule | null {
  const s = stem(file.path);
  const dir = path.posix.basename(path.posix.dirname(file.path)).toLowerCase();
  const ext = path.posix.extname(file.path).toLowerCase();
  if (PROMPT_EXT.has(ext)) {
    // Only prompt-like documents count (README etc. are skipped).
    return /prompt|rules?|policy|instruction|system|persona|template/.test(`${dir}/${s}`) ? RULES.find((r) => r.role === 'rules')! : null;
  }
  if (GENERIC.test(s)) return null;
  return RULES.find((r) => r.re.test(s)) ?? RULES.find((r) => r.role !== 'rules' && r.role !== 'store' && r.role !== 'client' && r.re.test(dir)) ?? null;
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

/** Import specifiers → repository paths (best effort, relative imports only). */
function importsOf(file: SourceFile, known: Map<string, string>): Set<string> {
  const out = new Set<string>();
  const dir = path.posix.dirname(file.path);
  const re = /(?:from\s+['"](\.{1,2}\/[^'"]+)['"]|require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|^\s*from\s+\.+([\w.]+)\s+import)/gm;
  for (const m of file.content.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) {
      const base = path.posix.normalize(path.posix.join(dir, spec)).replace(/\.(js|mjs|cjs|ts|tsx|jsx)$/, '');
      const hit = known.get(base) ?? known.get(`${base}/index`);
      if (hit) out.add(hit);
    } else if (m[4]) {
      const hit = known.get(path.posix.join(dir, m[4].replace(/\./g, '/')));
      if (hit) out.add(hit);
    }
  }
  return out;
}

interface Candidate { file: SourceFile; rule: RoleRule; models: string[]; score: number; importedBy: number }

export function analyzeRepository(files: SourceFile[], opts: { serviceId: string; projectName: string }): AnalysisResult {
  const usable = files
    .map((f) => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^\.?\//, '') }))
    .filter((f) => !SKIP_DIR.test(path.posix.dirname(f.path) + '/') && !SKIP_FILE.test(path.posix.basename(f.path)))
    .filter((f) => SOURCE_EXT.has(path.posix.extname(f.path).toLowerCase()) || PROMPT_EXT.has(path.posix.extname(f.path).toLowerCase()));

  const known = new Map<string, string>();
  for (const f of usable) known.set(f.path.replace(/\.[^.]+$/, ''), f.path);
  const imports = new Map(usable.map((f) => [f.path, importsOf(f, known)]));
  const importedBy = new Map<string, number>();
  for (const set of imports.values()) for (const p of set) importedBy.set(p, (importedBy.get(p) ?? 0) + 1);

  const allModels = new Set<string>();
  const candidates: Candidate[] = [];
  for (const f of usable) {
    const models = detectModels(f.content);
    models.forEach((m) => allModels.add(m));
    const rule = classify(f);
    if (!rule) continue;
    const s = stem(f.path);
    const score = (models.length ? 3 : 0) + (rule.re.test(s) ? 2 : 0) + Math.min(importedBy.get(f.path) ?? 0, 4) + Math.min(f.content.length / 8000, 2);
    candidates.push({ file: f, rule, models, score, importedBy: importedBy.get(f.path) ?? 0 });
  }

  const byRole = new Map<Role, Candidate[]>();
  for (const c of candidates) {
    const list = byRole.get(c.rule.role) ?? [];
    list.push(c);
    byRole.set(c.rule.role, list);
  }
  for (const [role, list] of byRole) {
    list.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
    const cap = role === 'store' || role === 'client' ? MAX_SIDE : role === 'critic' ? 1 : role === 'rules' ? 4 : MAX_PER_STAGE;
    byRole.set(role, list.slice(0, cap));
  }

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const usedIds = new Set<string>();
  const idFor = (base: string) => {
    let id = `n_${base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 50)}`;
    for (let i = 2; usedIds.has(id); i++) id = `n_${base.slice(0, 46)}_${i}`;
    usedIds.add(id);
    return id;
  };
  let edgeN = 0;
  const edge = (source: string, sourcePort: string, target: string, targetPort: string) => {
    if (edges.some((e) => e.source === source && e.target === target && e.targetPort === targetPort)) return;
    edges.push({ id: `e${++edgeN}`, source, sourcePort, target, targetPort });
  };
  const observed = { implementation: { kind: 'observed' as const, serviceId: opts.serviceId } };
  const inPort = { id: 'in', label: 'In', type: 'any' as const, required: false, multiple: true, merge: 'object_by_source' as const };
  const outPort = { id: 'out', label: 'Out', type: 'json' as const };
  const fileOf = new Map<string, string>(); // node id → file path

  const make = (c: Candidate, position: { x: number; y: number }): WorkflowNode => {
    const s = stem(c.file.path);
    const id = idFor(s);
    fileOf.set(id, c.file.path);
    const kind = c.rule.kind;
    const isInstruction = kind === 'instruction';
    const takesRules = kind === 'planner' || kind === 'worker' || kind === 'judge' || kind === 'scanner' || kind === 'aggregator' || kind === 'router';
    let label = titleCase(s);
    if (nodes.some((x) => x.label === label)) label = `${label} (${path.posix.basename(path.posix.dirname(c.file.path)) || 'root'})`;
    const n = nodeSchema.parse({
      id,
      kind,
      label: label.slice(0, 120),
      purpose: `${c.rule.label} stage detected from ${c.file.path}${c.models.length ? `. Models referenced: ${c.models.slice(0, 6).join(', ')}` : ''}.`,
      position,
      inputs: isInstruction || kind === 'datastore' || kind === 'api_service' ? (kind === 'datastore' ? [{ ...inPort, label: 'Write' }] : []) : takesRules ? [RULES_PORT, inPort] : [inPort],
      outputs: isInstruction ? [{ id: 'rules', label: 'Rules', type: 'rules' }] : [outPort],
      config: isInstruction ? { implementation: { kind: 'demo', handler: 'instruction' }, params: { models: c.models.slice(0, 8) } } : { ...observed, params: { models: c.models.slice(0, 8) } },
      instructions: isInstruction ? promptText(c.file) : '',
      codeRefs: [{ id: 'src', path: c.file.path, note: 'Detected by repository import' }],
    });
    nodes.push(n);
    return n;
  };

  // ---- main line ----
  const columns: WorkflowNode[][] = [];
  const entryFiles = usable.filter((f) => ENTRY.test(stem(f.path))).sort((a, b) => a.path.split('/').length - b.path.split('/').length).slice(0, 3);
  const input = nodeSchema.parse({
    id: idFor('input'), kind: 'input', label: 'Input', position: { x: 0, y: 0 },
    purpose: `Entry point of ${opts.projectName}${entryFiles.length ? ` (${entryFiles.map((f) => f.path).join(', ')})` : ''}.`,
    outputs: [{ id: 'request', label: 'Request', type: 'text' }],
    config: observed,
    codeRefs: entryFiles.map((f, i) => ({ id: `entry${i + 1}`, path: f.path })),
  });
  nodes.push(input);
  columns.push([input]);

  const stages = (Object.entries(STAGE) as [Role, number][]).sort((a, b) => a[1] - b[1]);
  for (const [role] of stages) {
    const list = byRole.get(role);
    if (!list?.length) continue;
    const x = columns.length * COL;
    const col = list.map((c, i) => make(c, { x, y: (i - (list.length - 1) / 2) * ROW }));
    columns.push(col);
  }

  const output = nodeSchema.parse({
    id: idFor('output'), kind: 'output', label: 'Output', position: { x: columns.length * COL, y: 0 },
    purpose: 'Final results returned to the user.',
    inputs: [{ id: 'in', label: 'In', type: 'any', multiple: true, merge: 'object_by_source' }],
    config: observed,
  });
  nodes.push(output);
  columns.push([output]);

  // Connect consecutive columns. Prefer real import relationships between the two stages.
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
    for (const [a, b] of pairs) edge(a.id, a.outputs[0].id, b.id, 'in');
  }

  // Reduce crossings: order each column by the mean row of its predecessors (one barycenter sweep).
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

  const mainNodes = columns.flat();
  const top = (col: WorkflowNode[]) => Math.min(...col.map((n) => n.position.y));
  const bottom = (col: WorkflowNode[]) => Math.max(...col.map((n) => n.position.y));
  const nodeTarget = (preferred: (n: WorkflowNode) => boolean) => mainNodes.find((n) => n.inputs.some((p) => p.id === 'rules') && preferred(n)) ?? mainNodes.find((n) => n.inputs.some((p) => p.id === 'rules'));

  // ---- rules (parallelograms) above the node they most likely govern ----
  const rules = byRole.get('rules') ?? [];
  const aboveCount = new Map<string, number>();
  for (const c of rules) {
    const f = c.file.path;
    // Governs: a main node whose file imports it, else the first planner/router, else the first rule-taking node.
    const target = mainNodes.find((n) => fileOf.has(n.id) && imports.get(fileOf.get(n.id)!)?.has(f) && n.inputs.some((p) => p.id === 'rules'))
      ?? nodeTarget((n) => n.kind === 'router' || n.kind === 'planner');
    const colIdx = target ? columns.findIndex((col) => col.includes(target)) : 1;
    const key = String(colIdx);
    const stack = aboveCount.get(key) ?? 0;
    aboveCount.set(key, stack + 1);
    const baseY = target ? top(columns[colIdx]) : 0;
    const n = make(c, { x: (target?.position.x ?? COL) + 10, y: baseY - 170 - stack * 110 });
    if (target) edge(n.id, 'rules', target.id, 'rules');
  }

  // ---- screeners (dashed side branches) off the node feeding judgement ----
  const screens = byRole.get('screen') ?? [];
  const judgeCol = columns.find((col) => col[0].kind === 'judge');
  const anchorCol = judgeCol ? columns[columns.indexOf(judgeCol) - 1] : columns[Math.max(1, columns.length - 2)];
  screens.forEach((c, i) => {
    const anchor = anchorCol[0];
    const above = i % 2 === 0;
    const y = above ? top(anchorCol) - 170 - Math.floor(i / 2) * 120 : bottom(anchorCol) + 170 + Math.floor(i / 2) * 120;
    const n = make(c, { x: anchor.position.x + 20, y });
    edge(anchor.id, anchor.outputs[0].id, n.id, 'in');
  });

  // ---- critic after the output ----
  for (const c of byRole.get('critic') ?? []) {
    const feeder = columns[columns.length - 2][0];
    const n = make(c, { x: output.position.x + 30, y: -200 });
    edge(feeder.id, feeder.outputs[0].id, n.id, 'in');
  }

  // ---- judge ensemble container ----
  if (judgeCol && judgeCol.length >= 2) {
    const minY = top(judgeCol) - 60;
    const maxY = bottom(judgeCol) + 210;
    const g = nodeSchema.parse({
      id: idFor('judges'), kind: 'group', label: 'Judges', position: { x: judgeCol[0].position.x - 25, y: minY },
      display: { width: 280, height: Math.round(maxY - minY) },
      purpose: 'Judge ensemble detected from multiple judge/review modules.',
      config: { implementation: { kind: 'none' } },
    });
    nodes.unshift(g); // render behind its members
  }

  // ---- side row: data stores and model clients ----
  const side = [...(byRole.get('store') ?? []), ...(byRole.get('client') ?? [])];
  const sideY = Math.max(...nodes.map((n) => n.position.y)) + 260;
  side.forEach((c, i) => {
    const users = mainNodes.filter((m) => {
      const f = fileOf.get(m.id);
      return f && imports.get(f)?.has(c.file.path) && m.inputs.some((p) => p.id === 'in');
    });
    const n = make(c, { x: COL + (i % 6) * COL, y: sideY + Math.floor(i / 6) * ROW });
    // Wire it to the nodes that import it, unless it is shared infrastructure used almost everywhere.
    if (users.length <= 3) for (const m of users) edge(n.id, 'out', m.id, 'in');
    else n.purpose += ` Shared by ${users.length} stages: ${users.map((m) => m.label).join(', ')}.`;
  });

  const languages = [...new Set(usable.map((f) => path.posix.extname(f.path).slice(1).toLowerCase()).filter((e) => SOURCE_EXT.has(`.${e}`)))];
  return {
    nodes,
    edges,
    stats: { filesScanned: usable.length, filesMatched: nodes.filter((n) => n.codeRefs.length).length, models: [...allModels].slice(0, 60), languages },
  };
}
