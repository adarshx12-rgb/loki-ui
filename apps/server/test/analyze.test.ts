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

describe('model detection', () => {
  it('finds versioned model ids and ignores prose', () => {
    expect(detectModels("use 'gemini-3.8-flash' or openai/gpt-6-luna; Gemini-only path; claude-skills; o3 ")).toEqual(['openai/gpt-6-luna', 'gemini-3.8-flash']);
  });
  it('extracts prose prompts from source files', () => {
    expect(promptText({ path: 'a.ts', content: `const a = "short"; const p = \`${PROMPT}\`;` })).toBe(PROMPT);
  });
});
