/**
 * Per-endpoint workflow aliases. These matter because a bundle ships a
 * CANONICAL workflow naming model files the author had, and the operator's box
 * usually has different filenames (a quant, an FP8 variant). The alias store is
 * what reconciles the two — so a silent failure here means Comfy rejects the
 * graph on a missing model, or worse, renders with the wrong one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aliasEndpointKey,
  applyAliases,
  applyEndpointAliases,
  endpointSlug,
  isCloudEndpoint,
  readAliases,
  validateClassSwaps,
  writeAliases,
  type ComfyWorkflow,
} from '../src/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aliases-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const LOCAL = 'http://127.0.0.1:8188';
const CLOUD = 'https://cloud.comfy.org';
const PROXY = 'https://dhee.studio/comfy/api';

function seed(endpoint: string, aliases: unknown): void {
  const d = join(dir, endpointSlug(aliasEndpointKey(endpoint)));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'aliases.json'), JSON.stringify(aliases));
}

describe('endpoint keying', () => {
  it('collapses every non-cloud URL to one stable self.local key', () => {
    // The whole point: a tailnet name, a LAN IP and a tunnel are all the same
    // physical box, so model substitutions must not be orphaned by a URL change.
    for (const u of [LOCAL, 'http://192.168.1.9:8188', 'http://5090.tail3cca41.ts.net:9000/comfyui']) {
      expect(aliasEndpointKey(u)).toBe('self.local');
    }
  });

  it('keys cloud endpoints per host, so separate model libraries stay separate', () => {
    expect(aliasEndpointKey(CLOUD)).toBe(CLOUD);
    expect(aliasEndpointKey(PROXY)).toBe(PROXY);
    expect(aliasEndpointKey(CLOUD)).not.toBe(aliasEndpointKey(PROXY));
  });

  it('recognises both cloud shapes and neither local shape', () => {
    expect(isCloudEndpoint(CLOUD)).toBe(true);
    expect(isCloudEndpoint(PROXY)).toBe(true);
    expect(isCloudEndpoint(LOCAL)).toBe(false);
  });

  it('produces a filesystem-safe slug', () => {
    expect(endpointSlug(CLOUD)).not.toMatch(/[/:]/);
  });
});

describe('read / write round-trip', () => {
  it('reads back what it wrote, under the same endpoint key', () => {
    writeAliases(dir, LOCAL, { name_aliases: { 'a.safetensors': 'b.safetensors' } });
    expect(readAliases(dir, LOCAL).name_aliases).toEqual({ 'a.safetensors': 'b.safetensors' });
  });

  it('a different local URL reads the SAME store (the self.local collapse)', () => {
    writeAliases(dir, LOCAL, { name_aliases: { 'a.safetensors': 'b.safetensors' } });
    expect(readAliases(dir, 'http://10.0.0.5:8188').name_aliases).toEqual({
      'a.safetensors': 'b.safetensors',
    });
  });

  it('returns empty for an unknown endpoint rather than throwing', () => {
    expect(readAliases(dir, CLOUD)).toEqual({});
  });

  it('survives a malformed store instead of poisoning the run', () => {
    const d = join(dir, endpointSlug('self.local'));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'aliases.json'), '{ not json');
    expect(readAliases(dir, LOCAL)).toEqual({});
  });
});

describe('applyAliases — model-file renames', () => {
  const wf = (): ComfyWorkflow => ({
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_edit_2511_bf16.safetensors' } },
    '2': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'lightning-4step.safetensors' } },
  });

  it('rewrites a model filename the operator does not have to the one they do', () => {
    // The real case from a live alias store: the bundle names a bf16 checkpoint,
    // the box has the FP8 build.
    const g = wf();
    const out = applyAliases(g, {
      workflowKey: 'workflows/qwen_edit.json',
      aliases: {
        name_aliases: {
          'qwen_image_edit_2511_bf16.safetensors': 'Qwen-Image-Edit-2511-FP8_e4m3fn.safetensors',
        },
      },
    });
    expect(out['1']!.inputs['unet_name']).toBe('Qwen-Image-Edit-2511-FP8_e4m3fn.safetensors');
    expect(out['2']!.inputs['lora_name']).toBe('lightning-4step.safetensors');
    // Deep-clones by contract: the caller's graph must be untouched.
    expect(g['1']!.inputs['unet_name']).toBe('qwen_image_edit_2511_bf16.safetensors');
  });

  it('leaves the graph untouched when no alias matches', () => {
    const g = wf();
    const before = JSON.stringify(g);
    const out = applyAliases(g, { workflowKey: 'w.json', aliases: { name_aliases: { 'nope.ckpt': 'other.ckpt' } } });
    expect(JSON.stringify(out)).toBe(before);
  });

  it('is a no-op for an empty alias set', () => {
    const g = wf();
    const before = JSON.stringify(g);
    expect(JSON.stringify(applyAliases(g, { workflowKey: 'w.json', aliases: {} }))).toBe(before);
  });
});

describe('validateClassSwaps', () => {
  const wf: ComfyWorkflow = {
    '5': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'x.safetensors' } },
  };

  it('flags a swap target that is not installed on the endpoint', () => {
    const p = validateClassSwaps(wf, [{ nodeId: '5', from: 'LoraLoaderModelOnly', to: 'MissingNode' }], {});
    expect(p).toEqual([
      { nodeId: '5', from: 'LoraLoaderModelOnly', to: 'MissingNode', issue: 'class-not-on-endpoint' },
    ]);
  });

  it('flags a swap that leaves a required input unsatisfied', () => {
    // The documented trap: LoraLoaderModelOnly -> "Load Lora" needs `clip`,
    // which the node does not provide, and Comfy would reject it with a 400
    // deep inside prompt validation.
    const p = validateClassSwaps(
      wf,
      [{ nodeId: '5', from: 'LoraLoaderModelOnly', to: 'LoraLoader' }],
      { LoraLoader: { input: { required: { model: [], clip: [], lora_name: [] } } } },
    );
    expect(p).toHaveLength(1);
    expect(p[0]!.issue).toBe('missing-required-inputs');
    expect(p[0]!.missing).toEqual(['clip']);
  });

  it('passes a swap whose required inputs are all present', () => {
    const p = validateClassSwaps(
      wf,
      [{ nodeId: '5', from: 'LoraLoaderModelOnly', to: 'LoraLoaderModelOnlyGGUF' }],
      { LoraLoaderModelOnlyGGUF: { input: { required: { model: [], lora_name: [] } } } },
    );
    expect(p).toEqual([]);
  });

  it('ignores a swap naming a node that is not in the graph', () => {
    expect(validateClassSwaps(wf, [{ nodeId: '999', from: 'A', to: 'B' }], {})).toEqual([]);
  });
});

describe('applyEndpointAliases', () => {
  const wf = (): ComfyWorkflow => ({
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'bf16.safetensors' } },
  });

  it('applies the store for the resolved endpoint', async () => {
    seed(LOCAL, { name_aliases: { 'bf16.safetensors': 'fp8.safetensors' } });
    const res = await applyEndpointAliases({
      workflow: wf(),
      workflowKey: 'workflows/w.json',
      aliasesDir: dir,
      endpointUrl: LOCAL,
    });
    expect(res.error).toBeUndefined();
    expect(res.workflow['1']!.inputs['unet_name']).toBe('fp8.safetensors');
  });

  it('does not probe /object_info when no class_swap was applied', async () => {
    // Renames alone need no endpoint validation, so a rename-only store must
    // never pay a network round-trip.
    seed(LOCAL, { name_aliases: { 'bf16.safetensors': 'fp8.safetensors' } });
    const fetchObjectInfo = vi.fn(async () => ({}));
    await applyEndpointAliases({
      workflow: wf(),
      workflowKey: 'w.json',
      aliasesDir: dir,
      endpointUrl: LOCAL,
      fetchObjectInfo,
    });
    expect(fetchObjectInfo).not.toHaveBeenCalled();
  });

  it('threads the abort signal into the /object_info probe', async () => {
    seed(LOCAL, { class_swaps: { 'w.json': { '1': 'UNETLoaderGGUF' } } });
    const ac = new AbortController();
    let seenSignal: AbortSignal | undefined;
    await applyEndpointAliases({
      workflow: wf(),
      workflowKey: 'w.json',
      aliasesDir: dir,
      endpointUrl: LOCAL,
      signal: ac.signal,
      fetchObjectInfo: async (_u, s) => {
        seenSignal = s;
        return { UNETLoaderGGUF: { input: { required: { unet_name: [] } } } };
      },
    });
    expect(seenSignal).toBe(ac.signal);
  });

  it('degrades to "validation skipped" when the probe fails, and still applies', async () => {
    // Validation is best-effort: an unreachable endpoint must not block a render.
    seed(LOCAL, { class_swaps: { 'w.json': { '1': 'UNETLoaderGGUF' } } });
    const logs: string[] = [];
    const res = await applyEndpointAliases({
      workflow: wf(),
      workflowKey: 'w.json',
      aliasesDir: dir,
      endpointUrl: LOCAL,
      log: (m) => logs.push(m),
      fetchObjectInfo: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(res.error).toBeUndefined();
    expect(logs.join(' ')).toMatch(/validation skipped/i);
  });

  it('returns an actionable error when a swap target is absent from the endpoint', async () => {
    seed(LOCAL, { class_swaps: { 'w.json': { '1': 'NotInstalled' } } });
    const res = await applyEndpointAliases({
      workflow: wf(),
      workflowKey: 'w.json',
      aliasesDir: dir,
      endpointUrl: LOCAL,
      fetchObjectInfo: async () => ({}),
    });
    expect(res.error).toMatch(/NotInstalled/);
    expect(res.error).toMatch(/NOT installed/i);
  });

  it('is a no-op with no store, and never touches the network', async () => {
    const fetchObjectInfo = vi.fn(async () => ({}));
    const res = await applyEndpointAliases({
      workflow: wf(),
      workflowKey: 'w.json',
      aliasesDir: dir,
      endpointUrl: LOCAL,
      fetchObjectInfo,
    });
    expect(res.error).toBeUndefined();
    expect(res.workflow['1']!.inputs['unet_name']).toBe('bf16.safetensors');
    expect(fetchObjectInfo).not.toHaveBeenCalled();
  });

  it('skips validation entirely when no endpoint URL is known', async () => {
    seed(LOCAL, { class_swaps: { 'w.json': { '1': 'UNETLoaderGGUF' } } });
    const res = await applyEndpointAliases({ workflow: wf(), workflowKey: 'w.json', aliasesDir: dir });
    expect(res.error).toBeUndefined();
  });
});
