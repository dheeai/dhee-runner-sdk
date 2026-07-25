import { describe, expect, it } from 'vitest';
import {
  injectParameter,
  pruneAndRedirect,
  type ComfyWorkflow,
} from '../src/comfyGraph.js';

/** A small reference-chain graph: 3 loaders → 3 ReferenceLatents → a sampler. */
function refChain(): ComfyWorkflow {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: 'a.png' } },
    '2': { class_type: 'LoadImage', inputs: { image: 'b.png' } },
    '3': { class_type: 'LoadImage', inputs: { image: 'c.png' } },
    '11': { class_type: 'ReferenceLatent', inputs: { image: ['1', 0], conditioning: ['20', 0] } },
    '12': { class_type: 'ReferenceLatent', inputs: { image: ['2', 0], conditioning: ['11', 0] } },
    '13': { class_type: 'ReferenceLatent', inputs: { image: ['3', 0], conditioning: ['12', 0] } },
    '20': { class_type: 'CLIPTextEncode', inputs: { text: 'hello' } },
    '30': { class_type: 'KSampler', inputs: { positive: ['13', 0], seed: 1 } },
  };
}

describe('injectParameter', () => {
  it('sets the field on the named node', () => {
    const wf = refChain();
    expect(injectParameter(wf, { nodeId: '20', field: 'text' }, 'a cat')).toEqual({ ok: true });
    expect(wf['20']!.inputs['text']).toBe('a cat');
  });

  it('adds a field that was not previously present', () => {
    const wf = refChain();
    injectParameter(wf, { nodeId: '30', field: 'cfg' }, 7.5);
    expect(wf['30']!.inputs['cfg']).toBe(7.5);
  });

  it('errors naming the node id when the node is absent, rather than silently no-op', () => {
    const wf = refChain();
    const res = injectParameter(wf, { nodeId: '999', field: 'text', input: 'prompt' }, 'x');
    expect(res).toEqual({
      ok: false,
      error:
        "parameterMapping refers to nodeId '999' (input 'prompt') but that node is not in the workflow.",
    });
  });

  it('does not throw and leaves the graph untouched on a missing node', () => {
    const wf = refChain();
    const before = JSON.stringify(wf);
    expect(() => injectParameter(wf, { nodeId: 'nope', field: 'f' }, 1)).not.toThrow();
    expect(JSON.stringify(wf)).toBe(before);
  });
});

describe('pruneAndRedirect', () => {
  it('deletes the named nodes and returns their ids', () => {
    const wf = refChain();
    const deleted = pruneAndRedirect(wf, { deleteNodes: ['3', '13'], redirects: [] });
    expect(deleted).toEqual(new Set(['3', '13']));
    expect(wf['3']).toBeUndefined();
    expect(wf['13']).toBeUndefined();
  });

  it('repoints a surviving consumer at the redirect target', () => {
    const wf = refChain();
    // Drop the last reference; the sampler should consume ref 12 instead.
    pruneAndRedirect(wf, { deleteNodes: ['3', '13'], redirects: [{ from: '13', to: '12' }] });
    expect(wf['30']!.inputs['positive']).toEqual(['12', 0]);
  });

  it('follows redirects transitively so a chain prunes in one order-independent pass', () => {
    // This is the ReferenceLatent case: drop refs 2 AND 3, consumers fall back
    // to ref 1 even though 13 -> 12 -> 11 requires two hops.
    const wf = refChain();
    pruneAndRedirect(wf, {
      deleteNodes: ['2', '3', '12', '13'],
      redirects: [
        { from: '13', to: '12' },
        { from: '12', to: '11' },
      ],
    });
    expect(wf['30']!.inputs['positive']).toEqual(['11', 0]);
    expect(Object.keys(wf).sort()).toEqual(['1', '11', '20', '30']);
  });

  it('is order-independent — redirects listed in reverse produce the same graph', () => {
    const forward = refChain();
    const reverse = refChain();
    const spec = (rs: Array<{ from: string; to: string }>) => ({
      deleteNodes: ['2', '3', '12', '13'],
      redirects: rs,
    });
    pruneAndRedirect(forward, spec([{ from: '13', to: '12' }, { from: '12', to: '11' }]));
    pruneAndRedirect(reverse, spec([{ from: '12', to: '11' }, { from: '13', to: '12' }]));
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
  });

  it('preserves the slot index while repointing the node id', () => {
    const wf: ComfyWorkflow = {
      '1': { inputs: {} },
      '2': { inputs: {} },
      '3': { inputs: { latent: ['1', 3] } },
    };
    pruneAndRedirect(wf, { deleteNodes: ['1'], redirects: [{ from: '1', to: '2' }] });
    expect(wf['3']!.inputs['latent']).toEqual(['2', 3]);
  });

  it('leaves non-link inputs alone, including 2-element arrays of non-strings', () => {
    const wf: ComfyWorkflow = {
      '1': { inputs: {} },
      '2': {
        inputs: {
          size: [512, 512],
          text: 'a photo',
          flag: true,
          link: ['1', 0],
        },
      },
    };
    pruneAndRedirect(wf, { deleteNodes: [], redirects: [{ from: '1', to: '9' }] });
    expect(wf['2']!.inputs['size']).toEqual([512, 512]);
    expect(wf['2']!.inputs['text']).toBe('a photo');
    expect(wf['2']!.inputs['flag']).toBe(true);
    expect(wf['2']!.inputs['link']).toEqual(['9', 0]);
  });

  it('is a no-op for an empty spec', () => {
    const wf = refChain();
    const before = JSON.stringify(wf);
    expect(pruneAndRedirect(wf, { deleteNodes: [], redirects: [] })).toEqual(new Set());
    expect(JSON.stringify(wf)).toBe(before);
  });

  it('tolerates a deleteNodes id that is not in the graph', () => {
    const wf = refChain();
    expect(() => pruneAndRedirect(wf, { deleteNodes: ['nope'], redirects: [] })).not.toThrow();
    expect(Object.keys(wf)).toHaveLength(8);
  });

  it('terminates on a cyclic redirect table instead of hanging', () => {
    const wf: ComfyWorkflow = {
      '1': { inputs: {} },
      '2': { inputs: {} },
      '3': { inputs: { x: ['1', 0] } },
    };
    // A malformed table must not spin forever — a hung runner is far worse
    // than a wrong-but-terminating repoint.
    expect(() =>
      pruneAndRedirect(wf, {
        deleteNodes: [],
        redirects: [
          { from: '1', to: '2' },
          { from: '2', to: '1' },
        ],
      }),
    ).not.toThrow();
    // The walk closes back on its start, so resolveFinal returns the original
    // id and the link is left exactly as it was. That is the good outcome for a
    // malformed table: terminate, and change nothing rather than something
    // arbitrary.
    expect(wf['3']!.inputs['x']).toEqual(['1', 0]);
  });

  it('does not rewrite links inside nodes that are themselves being deleted', () => {
    const wf = refChain();
    pruneAndRedirect(wf, { deleteNodes: ['13'], redirects: [{ from: '3', to: '2' }] });
    // 13 is gone, so its inputs were never touched; 30's link to 13 is left
    // dangling by design — the caller's table is responsible for redirecting it.
    expect(wf['13']).toBeUndefined();
    expect(wf['30']!.inputs['positive']).toEqual(['13', 0]);
  });
});
