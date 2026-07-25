/**
 * `ctx.cache` / `ctx.project` — the injected capability contract.
 *
 * These are type-level surfaces the ENGINE implements, so what is testable here
 * is the contract a runner must be able to rely on. The properties that matter
 * are the degradation ones: a runner given no cache, or a disabled cache, or a
 * cache whose `store` fails, must still produce a correct result. Getting that
 * wrong turns an optional optimisation into a hard dependency.
 */
import { describe, expect, it, vi } from 'vitest';
import { computeInputsHash, type GenerationCacheAccess, type InputsHashKey, type ProjectAccess } from '../src/index.js';

/** Minimal in-memory implementation, standing in for the engine's. */
function fakeCache(opts: { enabled?: boolean; failStore?: boolean } = {}): GenerationCacheAccess & {
  entries: Map<string, { source: string; metadata?: Record<string, unknown> }>;
  fetched: string[];
} {
  const entries = new Map<string, { source: string; metadata?: Record<string, unknown> }>();
  const fetched: string[] = [];
  return {
    entries,
    fetched,
    enabled: opts.enabled ?? true,
    async fetch(key, destAbsPath) {
      const hash = computeInputsHash(key);
      fetched.push(destAbsPath);
      const hit = entries.get(hash);
      return hit ? { hash, ...(hit.metadata ? { metadata: hit.metadata } : {}) } : null;
    },
    async store(key, sourceAbsPath, o) {
      if (opts.failStore) return null;
      const hash = computeInputsHash(key);
      entries.set(hash, { source: sourceAbsPath, ...(o?.metadata ? { metadata: o.metadata } : {}) });
      return { hash };
    },
  };
}

const project: ProjectAccess = { cacheScope: 'proj-abc', features: { narration: true } };

const keyFor = (scope: string, prompt: string): InputsHashKey => ({
  tool: 'comfy.tti',
  toolVersion: '0.1.0',
  inputs: { cacheScope: scope, prompt },
  config: {},
});

/**
 * A runner written against the contract: cache-aware, but correct without one.
 * This is the shape every externalized comfy runner will take.
 */
async function runnerWithCache(
  ctx: { cache?: GenerationCacheAccess; project?: ProjectAccess },
  prompt: string,
  dest: string,
  render: () => Promise<string>,
): Promise<{ outputPath: string; cached: boolean; rendered: boolean }> {
  const scope = ctx.project?.cacheScope ?? 'unscoped';
  const key = keyFor(scope, prompt);
  if (ctx.cache?.enabled) {
    const hit = await ctx.cache.fetch(key, dest);
    if (hit) return { outputPath: dest, cached: true, rendered: false };
  }
  const produced = await render();
  if (ctx.cache?.enabled) await ctx.cache.store(key, produced, { ext: 'png' });
  return { outputPath: dest, cached: false, rendered: true };
}

describe('a runner with no cache injected', () => {
  it('still renders and succeeds', async () => {
    const render = vi.fn(async () => '/tmp/out.png');
    const r = await runnerWithCache({ project }, 'a cat', '/tmp/dest.png', render);
    expect(r).toEqual({ outputPath: '/tmp/dest.png', cached: false, rendered: true });
    expect(render).toHaveBeenCalledOnce();
  });

  it('renders every time — no cache means recompute, never fail', async () => {
    const render = vi.fn(async () => '/tmp/out.png');
    await runnerWithCache({}, 'a cat', '/tmp/d.png', render);
    await runnerWithCache({}, 'a cat', '/tmp/d.png', render);
    expect(render).toHaveBeenCalledTimes(2);
  });
});

describe('a disabled cache', () => {
  it('is never consulted, so no key work is wasted', async () => {
    const cache = fakeCache({ enabled: false });
    const render = vi.fn(async () => '/tmp/out.png');
    const r = await runnerWithCache({ cache, project }, 'a cat', '/tmp/d.png', render);
    expect(r.rendered).toBe(true);
    expect(cache.fetched).toEqual([]);
    expect(cache.entries.size).toBe(0);
  });
});

describe('an enabled cache', () => {
  it('misses first, then hits — and the second run does not render', async () => {
    const cache = fakeCache();
    const render = vi.fn(async () => '/tmp/produced.png');

    const first = await runnerWithCache({ cache, project }, 'a cat', '/tmp/d1.png', render);
    expect(first).toMatchObject({ cached: false, rendered: true });

    const second = await runnerWithCache({ cache, project }, 'a cat', '/tmp/d2.png', render);
    expect(second).toMatchObject({ cached: true, rendered: false });
    // The whole point: an identical re-walk must not re-pay for the render.
    expect(render).toHaveBeenCalledOnce();
  });

  it('fetch targets the destination the RUNNER chose, not a store path', async () => {
    // Encapsulation: a runner never learns where the CAS keeps files, so the
    // engine can relocate or remote the store without breaking runners.
    const cache = fakeCache();
    await runnerWithCache({ cache, project }, 'a cat', '/tmp/mine.png', async () => '/tmp/p.png');
    expect(cache.fetched).toEqual(['/tmp/mine.png']);
  });

  it('a different prompt is a different key — no false hit', async () => {
    const cache = fakeCache();
    const render = vi.fn(async () => '/tmp/p.png');
    await runnerWithCache({ cache, project }, 'a cat', '/tmp/d.png', render);
    const other = await runnerWithCache({ cache, project }, 'a dog', '/tmp/d.png', render);
    expect(other.rendered).toBe(true);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('scopes by project, so two projects with identical inputs do not share entries', async () => {
    // The reason ProjectAccess.cacheScope exists.
    const cache = fakeCache();
    const render = vi.fn(async () => '/tmp/p.png');
    const other: ProjectAccess = { cacheScope: 'proj-xyz', features: {} };
    await runnerWithCache({ cache, project }, 'a cat', '/tmp/d.png', render);
    const second = await runnerWithCache({ cache, project: other }, 'a cat', '/tmp/d.png', render);
    expect(second.rendered).toBe(true);
    expect(cache.entries.size).toBe(2);
  });

  it('round-trips metadata on a hit', async () => {
    const cache = fakeCache();
    const key = keyFor('proj-abc', 'a cat');
    await cache.store(key, '/tmp/src.png', { ext: 'png', metadata: { bytes: 4096 } });
    const hit = await cache.fetch(key, '/tmp/d.png');
    expect(hit?.metadata).toEqual({ bytes: 4096 });
  });
});

describe('a failing store', () => {
  it('does not fail the run — the artifact was already produced', async () => {
    // store() is best-effort by contract. A full disk must not turn a good
    // render into a failed node.
    const cache = fakeCache({ failStore: true });
    const r = await runnerWithCache({ cache, project }, 'a cat', '/tmp/d.png', async () => '/tmp/p.png');
    expect(r).toMatchObject({ cached: false, rendered: true });
  });

  it('leaves nothing cached, so the next run recomputes rather than reading garbage', async () => {
    const cache = fakeCache({ failStore: true });
    const render = vi.fn(async () => '/tmp/p.png');
    await runnerWithCache({ cache, project }, 'a cat', '/tmp/d.png', render);
    await runnerWithCache({ cache, project }, 'a cat', '/tmp/d.png', render);
    expect(render).toHaveBeenCalledTimes(2);
  });
});

describe('ctx.project', () => {
  it('exposes a stable cacheScope and the engine-resolved features', () => {
    expect(project.cacheScope).toBe('proj-abc');
    expect(project.features['narration']).toBe(true);
  });

  it('falls back to an explicit sentinel when absent, rather than an empty scope', async () => {
    // An empty/undefined scope silently collapses every project into one
    // cache namespace, which is worse than not caching.
    const cache = fakeCache();
    await runnerWithCache({ cache }, 'a cat', '/tmp/d.png', async () => '/tmp/p.png');
    const withScope = await cache.fetch(keyFor('unscoped', 'a cat'), '/tmp/d.png');
    expect(withScope).not.toBeNull();
    expect(await cache.fetch(keyFor('proj-abc', 'a cat'), '/tmp/d.png')).toBeNull();
  });
});
