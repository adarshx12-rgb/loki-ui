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

describe('model detection', () => {
  it('finds versioned model ids and ignores prose', () => {
    expect(detectModels("use 'gemini-3.8-flash' or openai/gpt-6-luna; Gemini-only path; claude-skills; o3 ")).toEqual(['openai/gpt-6-luna', 'gemini-3.8-flash']);
  });
  it('extracts prose prompts from source files', () => {
    expect(promptText({ path: 'a.ts', content: `const a = "short"; const p = \`${PROMPT}\`;` })).toBe(PROMPT);
  });
});
