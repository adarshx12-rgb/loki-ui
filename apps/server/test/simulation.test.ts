import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_WORKFLOW_ID } from '@nodepilot/shared';
import { makeEnv, ui, type TestEnv } from './helpers.js';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe('simulation sandbox', () => {
  it('is a hidden copy: edits and runs there never touch the main project', async () => {
    env = await makeEnv();
    const main = env.ctx.store.get(EXAMPLE_WORKFLOW_ID);
    const start = await env.app.inject({ method: 'POST', url: `/api/workflows/${main.id}/simulation`, headers: ui(env) });
    expect(start.statusCode).toBe(200);
    const sandbox = start.json();
    expect(sandbox.simulationOf).toBe(main.id);
    expect(sandbox.nodes).toHaveLength(main.nodes.length);

    // Hidden from the project list, but found again after a reload.
    const list = (await env.app.inject({ method: 'GET', url: '/api/workflows', headers: ui(env) })).json() as { id: string }[];
    expect(list.some((w) => w.id === sandbox.id)).toBe(false);
    expect((await env.app.inject({ method: 'GET', url: `/api/workflows/${main.id}/simulation`, headers: ui(env) })).json().id).toBe(sandbox.id);

    // Edit the sandbox; main is unchanged.
    const edit = await env.app.inject({ method: 'POST', url: `/api/workflows/${sandbox.id}/patch`, headers: ui(env), payload: { baseRevision: sandbox.revision, ops: [{ op: 'remove_node', nodeId: 'n_scanner' }] } });
    expect(edit.statusCode).toBe(200);
    expect(env.ctx.store.get(main.id).nodes.some((n) => n.id === 'n_scanner')).toBe(true);
    expect(env.ctx.store.get(main.id).revision).toBe(main.revision);
  });

  it('starting again replaces the old sandbox, and deleting the project removes its sandbox', async () => {
    env = await makeEnv();
    const wf = env.ctx.store.create({ name: 'Mine' }, 'ui');
    const a = env.ctx.store.createSimulation(wf.id, 'ui');
    const b = env.ctx.store.createSimulation(wf.id, 'ui');
    expect(() => env!.ctx.store.get(a.id)).toThrow(/not found/);
    expect(env.ctx.store.simulationOf(wf.id)?.id).toBe(b.id);
    expect(() => env!.ctx.store.createSimulation(b.id, 'ui')).toThrow(/already a simulation/);

    const del = await env.app.inject({ method: 'DELETE', url: `/api/workflows/${wf.id}`, headers: ui(env) });
    expect(del.statusCode).toBe(200);
    expect(() => env!.ctx.store.get(b.id)).toThrow(/not found/);
  });
});
