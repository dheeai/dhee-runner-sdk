/**
 * Cloud-aware workflow selection — verifies `resolveWorkflowPath` picks a
 * `_cloud.json` variant when the endpoint is Comfy Cloud (direct or via the
 * dhee proxy) and falls back to the canonical workflow otherwise.
 *
 * Run: `node --test tests/` (uses Node's built-in test runner, zero deps).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveWorkflowPath,
  isCloudEndpoint,
} from '../dist/index.js';

function makeBundle() {
  const root = mkdtempSync(join(tmpdir(), 'dhee-wp-'));
  const wf = join(root, 'workflows');
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, 'foo.json'), '{}');
  writeFileSync(join(wf, 'foo_cloud.json'), '{}');
  writeFileSync(join(wf, 'bar_local.json'), '{}');
  writeFileSync(join(wf, 'bar_cloud.json'), '{}');
  writeFileSync(join(wf, 'only.json'), '{}');
  return root;
}

test('isCloudEndpoint: dhee proxy + cloud.comfy.org are cloud; naked local is not', () => {
  assert.equal(isCloudEndpoint('http://localhost:3000/comfy/api'), true);
  assert.equal(isCloudEndpoint('https://cloud.comfy.org/api'), true);
  assert.equal(isCloudEndpoint('http://127.0.0.1:8188'), false);
});

test('cloud endpoint -> X.json picks X_cloud.json (ideogram4.json -> ideogram4_cloud.json case)', () => {
  const bundle = makeBundle();
  const p = resolveWorkflowPath({
    workflowPath: 'workflows/foo.json',
    bundleDir: bundle,
    endpointUrl: 'http://localhost:3000/comfy/api',
  });
  assert.match(p, /foo_cloud\.json$/);
});

test('cloud endpoint -> X_local.json picks X_cloud.json (ltx_director_local -> _cloud case)', () => {
  const bundle = makeBundle();
  const p = resolveWorkflowPath({
    workflowPath: 'workflows/bar_local.json',
    bundleDir: bundle,
    endpointUrl: 'https://cloud.comfy.org/api',
  });
  assert.match(p, /bar_cloud\.json$/);
});

test('local endpoint -> keeps canonical (no _cloud swap)', () => {
  const bundle = makeBundle();
  const p = resolveWorkflowPath({
    workflowPath: 'workflows/foo.json',
    bundleDir: bundle,
    endpointUrl: 'http://127.0.0.1:8188',
  });
  assert.match(p, /foo\.json$/);
});

test('cloud endpoint but NO cloud variant -> falls back to canonical', () => {
  const bundle = makeBundle();
  const p = resolveWorkflowPath({
    workflowPath: 'workflows/only.json',
    bundleDir: bundle,
    endpointUrl: 'https://cloud.comfy.org/api',
  });
  assert.match(p, /only\.json$/);
});

test('explicit workflowPathCloud wins over the convention', () => {
  const bundle = makeBundle();
  writeFileSync(join(bundle, 'workflows', 'explicit_cloud.json'), '{}');
  const p = resolveWorkflowPath({
    workflowPath: 'workflows/foo.json',
    workflowPathCloud: 'workflows/explicit_cloud.json',
    bundleDir: bundle,
    endpointUrl: 'https://cloud.comfy.org/api',
  });
  assert.match(p, /explicit_cloud\.json$/);
});
