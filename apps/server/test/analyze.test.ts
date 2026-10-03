import { describe, expect, it } from 'vitest';
import { validateWorkflow } from '@nodepilot/shared';
import { analyzeRepository, detectModels, promptText } from '../src/analyze.js';

const PROMPT = 'You are a careful planner. Read the user request and write a requirements contract that lists every constraint the results must satisfy before any search begins.';

const repo = [
  { path: 'src/main.ts', content: "import { plan } from './planner.js';\nimport { judge } from './judge.js';" },
  { path: 'src/query-rewrite.ts', content: `export const SYSTEM = \`${PROMPT}\`;` },
  { path: 'src/planner.ts', content: "import { SYSTEM } from './query-rewrite.js';\nconst MODELS = ['openai/gpt-6-luna', 'google/gemma-4-31b-it'];" },
  { path: 'src/discovery.ts', content: "import { db } from './db.js';" },
  { path: 'src/screener.ts', content: 'export const screen = () => 1;' },
  { path: 'src/captions.ts', content: 'export const captions = () => 1;' },
  { path: 'src/judge.ts', content: "const model = 'gemini-3.5-flash-lite';" },
  { path: 'src/cascade.ts', content: "const strong = 'claude-haiku-4.5';" },
  { path: 'src/ranking.ts', content: 'export const rank = () => 1;' },
  { path: 'src/critic.ts', content: "const critic = 'moonshotai/kimi-k3';" },
  { path: 'src/db.ts', content: 'export const db = {};' },
  { path: 'src/config.ts', content: "const x = 'gemini-3.8-flash';" },
  { path: 'tests/judge.test.ts', content: '' },
  { path: 'node_modules/x/planner.js', content: '' },
];

describe('repository analysis', () => {
  const r = analyzeRepository(repo, { serviceId: 'demo-app', projectName: 'Demo' });
  const byLabel = (l: string) => r.nodes.find((n) => n.label === l)!;

  it('maps files to stages and shapes', () => {
    expect(byLabel('Input').kind).toBe('input');
    expect(byLabel('Output').kind).toBe('output');
    expect(byLabel('Planner').kind).toBe('planner');
    expect(byLabel('Query Rewrite').kind).toBe('instruction');
    expect(byLabel('Discovery').kind).toBe('scanner');
    expect(byLabel('Screener').kind).toBe('auxiliary');
    expect(byLabel('Captions').kind).toBe('worker');
    expect(byLabel('Ranking').kind).toBe('aggregator');
    expect(byLabel('Critic').kind).toBe('judge');
    expect(byLabel('Db').kind).toBe('datastore');
    // judge + cascade form an ensemble container
    expect(r.nodes.find((n) => n.kind === 'group')?.label).toBe('Judges');
    // tests, dependencies and generic config files are ignored
    expect(r.nodes.some((n) => n.codeRefs.some((c) => c.path.includes('node_modules') || c.path.startsWith('tests/') || c.path === 'src/config.ts'))).toBe(false);
  });

  it('flows left to right and attaches rules to the top of the node that imports them', () => {
    const x = (l: string) => byLabel(l).position.x;
    expect(x('Input')).toBeLessThan(x('Planner'));
    expect(x('Planner')).toBeLessThan(x('Discovery'));
    expect(x('Discovery')).toBeLessThan(x('Captions'));
    expect(x('Captions')).toBeLessThan(x('Judge'));
    expect(x('Judge')).toBeLessThan(x('Ranking'));
    expect(x('Ranking')).toBeLessThan(x('Output'));
    const rules = r.edges.find((e) => e.source === byLabel('Query Rewrite').id);
    expect(rules).toMatchObject({ target: byLabel('Planner').id, targetPort: 'rules' });
    expect(byLabel('Query Rewrite').position.y).toBeLessThan(byLabel('Planner').position.y);
    expect(byLabel('Query Rewrite').instructions).toContain('careful planner');
  });

  it('records models per node and produces a valid workflow', () => {
    expect((byLabel('Planner').config.params as { models: string[] }).models).toEqual(['openai/gpt-6-luna', 'google/gemma-4-31b-it']);
    expect((byLabel('Cascade').config.params as { models: string[] }).models).toEqual(['claude-haiku-4.5']);
    const v = validateWorkflow(
      { schemaVersion: 1, id: 'wf_x', name: 'Demo', revision: 1, nodes: r.nodes, edges: r.edges, createdAt: '', updatedAt: '' },
      { credentialAvailable: () => false, knownServiceIds: new Set(['demo-app']) },
    );
    expect(v.issues.filter((i) => i.level !== 'warning')).toEqual([]);
    expect(v.runnable).toBe(true);
  });
});

describe('ordinary projects keep their real structure', () => {
  // A typical Next.js app: pages, components, an API route, a lib folder, Supabase and Gemini. No planner, no judge.
  const nextApp = [
    { path: 'package.json', content: '{"name":"momentscout"}' },
    { path: 'app/page.tsx', content: "import { ResultCard } from '@/components/results/ResultCard';\nexport default function Page() { return null; }" },
    { path: 'app/layout.tsx', content: 'export default function Layout() { return null; }' },
    { path: 'app/api/search/route.ts', content: "import { searchVideos } from '@/lib/analysis/search';\nexport async function GET() { return searchVideos(); }" },
    { path: 'components/results/ResultCard.tsx', content: 'export function ResultCard() { return null; }' },
    { path: 'components/results/ResultsView.tsx', content: "import { ResultCard } from './ResultCard';\nexport function ResultsView() { return null; }" },
    { path: 'lib/analysis/search.ts', content: "import { db } from '../db/client';\nimport { GoogleGenAI } from '@google/genai';\nconst model = 'gemini-3.8-flash';\nexport const searchVideos = () => db;" },
    { path: 'lib/analysis/highlights.ts', content: "import { GoogleGenAI } from '@google/genai';" },
    { path: 'lib/db/client.ts', content: "import { createClient } from '@supabase/supabase-js';\nexport const db = createClient('', '');" },
    { path: '.data/transcript-venv/Lib/site-packages/pkg_resources/__init__.py', content: 'import os' },
    { path: 'transcript-venv/Lib/site-packages/pip/_vendor/pep517/dirtools.py', content: 'import os' },
  ];
  const r = analyzeRepository(nextApp, { serviceId: 'momentscout', projectName: 'MomentScout' });
  const byLabel = (l: string) => r.nodes.find((n) => n.label === l);

  it('uses the structure layout and never invents AI stages', () => {
    expect(r.stats.mode).toBe('structure');
    expect(r.nodes.some((n) => ['planner', 'judge', 'scanner', 'aggregator', 'worker'].includes(n.kind))).toBe(false);
    // UI components are UI, not "ranking" steps
    expect(byLabel('Results (components)')?.kind).toBe('ui');
  });

  it('maps entry points → modules → external services', () => {
    const api = byLabel('Search API')!;
    const analysis = byLabel('Analysis')!;
    const supabase = byLabel('Supabase')!;
    const gemini = byLabel('Google Gemini')!;
    expect(api).toBeDefined();
    expect(analysis.kind).toBe('model'); // it calls Gemini
    expect(supabase.kind).toBe('datastore');
    expect(gemini.kind).toBe('api_service');
    const has = (a: string, b: string) => r.edges.some((e) => e.source === a && e.target === b);
    const input = r.nodes.find((n) => n.kind === 'input')!;
    expect(has(input.id, api.id)).toBe(true);
    expect(has(api.id, analysis.id)).toBe(true);
    expect(has(analysis.id, gemini.id)).toBe(true);
    expect(api.position.x).toBeLessThan(analysis.position.x);
    expect(analysis.position.x).toBeLessThan(gemini.position.x);
  });

  it('skips virtualenvs, site-packages and hidden folders', () => {
    expect(r.nodes.some((n) => n.codeRefs.some((c) => /venv|site-packages|^\./.test(c.path)))).toBe(false);
    expect(r.stats.filesScanned).toBe(8);
  });

  it('respects the layout chosen at import', () => {
    expect(analyzeRepository(repo, { serviceId: 'x', projectName: 'x', mode: 'structure' }).stats.mode).toBe('structure');
    expect(analyzeRepository(nextApp, { serviceId: 'x', projectName: 'x', mode: 'pipeline' }).stats.mode).toBe('pipeline');
  });

  it('follows imports between a monorepo’s own packages', () => {
    const mono = analyzeRepository([
      { path: 'packages/shared/package.json', content: '{"name":"@acme/shared"}' },
      { path: 'packages/shared/src/index.ts', content: 'export const x = 1;' },
      { path: 'apps/api/src/index.ts', content: "import { x } from '@acme/shared';" },
    ], { serviceId: 'x', projectName: 'x' });
    const api = mono.nodes.find((n) => n.label === 'Api')!;
    const shared = mono.nodes.find((n) => n.label === 'Shared')!;
    expect(mono.edges.some((e) => e.source === api.id && e.target === shared.id)).toBe(true);
  });
});

describe('projects that run their own models (e.g. a browser video background remover)', () => {
  const app = [
    { path: 'package.json', content: '{"name":"video-bg-remove"}' },
    { path: 'src/config.ts', content: "export const BEN2_MODEL = {\n  repo: 'onnx-community/BEN2-ONNX',\n};\nexport const RVM_MODEL = { url: 'https://github.com/PeterL1n/RobustVideoMatting/releases/x' };" },
    { path: 'src/components/Studio.tsx', content: "import { Stage } from './studio/Stage';\nimport { createProcessor } from '../lib/processorClient';\nexport function Studio() { return <input type=\"file\" accept=\"video/*,.mp4,.mov,.webm\" />; }" },
    { path: 'src/components/studio/Stage.tsx', content: 'export function Stage() { return <a download="out.webm" />; }' },
    { path: 'src/lib/processorClient.ts', content: "export const createProcessor = () => new Worker(new URL('../worker/processor.worker.ts', import.meta.url));" },
    { path: 'src/lib/pipeline.ts', content: "import { composite } from './compositing/compositor';\nexport const run = () => { new MediaRecorder(s, { mimeType: 'video/webm' }); composite(); };" },
    { path: 'src/lib/compositing/compositor.ts', content: 'export const composite = () => 1;' },
    { path: 'src/worker/processor.worker.ts', content: "import { run } from '../lib/pipeline';\nimport { ben2 } from '../lib/models/ben2';\nimport { rvm } from '../lib/models/rvm';" },
    { path: 'src/lib/models/ben2.ts', content: "import { pipeline } from '@huggingface/transformers';\nimport { BEN2_MODEL } from '../../config';\nimport { cachedFetch } from './cachedFetch';\nexport const ben2 = 1;" },
    { path: 'src/lib/models/rvm.ts', content: "import { loadGraphModel } from '@tensorflow/tfjs-converter';\nimport { RVM_MODEL } from '../../config';\nexport const rvm = 1;" },
    { path: 'src/lib/models/cachedFetch.ts', content: 'export const cachedFetch = 1;' },
    { path: 'src/lib/models/errors.ts', content: 'export class GpuBackendError extends Error {}' },
    // scratch runs and browser profiles: never part of the picture
    ...Array.from({ length: 12 }, (_, i) => ({ path: `test-results/debug-${i}.mjs`, content: "import x from '../src/lib/models/ben2';" })),
    { path: 'tests/harness/bench-rvm.ts', content: 'export {}' },
  ];
  const r = analyzeRepository(app, { serviceId: 'vbr', projectName: 'video bg remove' });
  const label = (l: string) => r.nodes.find((n) => n.label === l);

  it('is concise: no scratch scripts, no helper files, one box per real part', () => {
    expect(r.nodes.some((n) => n.codeRefs.some((c) => c.path.startsWith('test-results/') || c.path.startsWith('tests/')))).toBe(false);
    expect(r.nodes.some((n) => /cached|errors/i.test(n.label))).toBe(false);
    expect(r.nodes.length).toBeLessThanOrEqual(12);
  });

  it('shows each local model inside a "Local models" group, with its runtime and source', () => {
    const ben2 = label('BEN2')!;
    const rvm = label('RVM')!;
    expect(ben2.kind).toBe('model');
    expect((ben2.config.params as { models: string[] }).models).toEqual(['Transformers.js', 'onnx-community/BEN2-ONNX']);
    expect((rvm.config.params as { models: string[] }).models[0]).toBe('TensorFlow.js');
    const group = r.nodes.find((n) => n.kind === 'group')!;
    expect(group.label).toBe('Local models');
    expect(ben2.position.x).toBe(rvm.position.x);
  });

  it('labels input and output with the file formats, and merges Studio.tsx with its studio/ folder', () => {
    expect(r.nodes.find((n) => n.kind === 'input')!.label).toBe('mp4 · mov · webm');
    expect(r.nodes.find((n) => n.kind === 'output')!.label).toBe('webm');
    expect(label('Studio')?.kind).toBe('ui');
    expect(r.nodes.filter((n) => /studio/i.test(n.label))).toHaveLength(1);
    // the flow reads left to right: input → Studio → … → models
    expect(label('Studio')!.position.x).toBeLessThan(label('BEN2')!.position.x);
  });
});

describe('model detection', () => {
  it('finds versioned model ids and ignores prose', () => {
    expect(detectModels("use 'gemini-3.8-flash' or openai/gpt-6-luna; Gemini-only path; claude-skills; o3 ")).toEqual(['openai/gpt-6-luna', 'gemini-3.8-flash']);
  });
  it('extracts prose prompts from source files', () => {
    expect(promptText({ path: 'a.ts', content: `const a = "short"; const p = \`${PROMPT}\`;` })).toBe(PROMPT);
  });
});
