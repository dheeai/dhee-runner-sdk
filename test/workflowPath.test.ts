/**
 * Cloud-aware workflow selection — `resolveWorkflowPath` must pick a
 * `_cloud.json` variant when the endpoint is Comfy Cloud (direct or via the
 * dhee proxy) and fall back to the canonical workflow otherwise.
 *
 * Ported from the `node:test` version that arrived with the Comfy kit, so it
 * runs in the same vitest suite as everything else.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCloudEndpoint, resolveWorkflowPath } from '../src/workflowPath.js';

const made: string[] = [];

function makeBundle(): string {
  const root = mkdtempSync(join(tmpdir(), 'dhee-wp-'));
  made.push(root);
  const wf = join(root, 'workflows');
  mkdirSync(wf, { recursive: true });
  for (const f of ['foo.json', 'foo_cloud.json', 'bar_local.json', 'bar_cloud.json', 'only.json']) {
    writeFileSync(join(wf, f), '{}');
  }
  return root;
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('isCloudEndpoint', () => {
  it('treats the dhee proxy and cloud.comfy.org as cloud', () => {
    expect(isCloudEndpoint('http://localhost:3000/comfy/api')).toBe(true);
    expect(isCloudEndpoint('https://cloud.comfy.org/api')).toBe(true);
    expect(isCloudEndpoint('https://CLOUD.COMFY.ORG/api')).toBe(true);
  });

  it('does not treat a local Comfy as cloud', () => {
    expect(isCloudEndpoint('http://127.0.0.1:8188')).toBe(false);
    expect(isCloudEndpoint('http://5090.tail3cca41.ts.net:9000/comfyui')).toBe(false);
  });
});

describe('resolveWorkflowPath', () => {
  it('swaps X.json → X_cloud.json on a cloud endpoint', () => {
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/foo.json',
      bundleDir: makeBundle(),
      endpointUrl: 'http://localhost:3000/comfy/api',
    });
    expect(p).toMatch(/foo_cloud\.json$/);
  });

  it('swaps X_local.json → X_cloud.json on a cloud endpoint', () => {
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/bar_local.json',
      bundleDir: makeBundle(),
      endpointUrl: 'https://cloud.comfy.org/api',
    });
    expect(p).toMatch(/bar_cloud\.json$/);
  });

  it('keeps the canonical path on a local endpoint', () => {
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/foo.json',
      bundleDir: makeBundle(),
      endpointUrl: 'http://127.0.0.1:8188',
    });
    expect(p).toMatch(/[/]foo\.json$/);
  });

  it('keeps the canonical path when no endpoint is supplied at all', () => {
    const p = resolveWorkflowPath({ workflowPath: 'workflows/foo.json', bundleDir: makeBundle() });
    expect(p).toMatch(/[/]foo\.json$/);
  });

  it('falls back to the canonical path when the cloud variant does not exist', () => {
    // This is the safety property: a bundle with no cloud variant must be
    // completely unaffected by cloud routing, not fail resolution.
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/only.json',
      bundleDir: makeBundle(),
      endpointUrl: 'https://cloud.comfy.org/api',
    });
    expect(p).toMatch(/only\.json$/);
  });

  it('prefers an explicit workflowPathCloud over the convention', () => {
    const bundle = makeBundle();
    writeFileSync(join(bundle, 'workflows', 'explicit_cloud.json'), '{}');
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/foo.json',
      workflowPathCloud: 'workflows/explicit_cloud.json',
      bundleDir: bundle,
      endpointUrl: 'https://cloud.comfy.org/api',
    });
    expect(p).toMatch(/explicit_cloud\.json$/);
  });

  it('ignores a workflowPathCloud that does not resolve, falling back to the convention', () => {
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/foo.json',
      workflowPathCloud: 'workflows/does_not_exist_cloud.json',
      bundleDir: makeBundle(),
      endpointUrl: 'https://cloud.comfy.org/api',
    });
    expect(p).toMatch(/foo_cloud\.json$/);
  });

  it('returns an absolute path, resolved against bundleDir', () => {
    const bundle = makeBundle();
    const p = resolveWorkflowPath({ workflowPath: 'workflows/foo.json', bundleDir: bundle });
    expect(p.startsWith('/')).toBe(true);
    expect(p).toBe(join(bundle, 'workflows', 'foo.json'));
  });

  it('passes an absolute workflowPath through unchanged', () => {
    const bundle = makeBundle();
    const abs = join(bundle, 'workflows', 'foo.json');
    expect(resolveWorkflowPath({ workflowPath: abs, bundleDir: '/elsewhere' })).toBe(abs);
  });
});
