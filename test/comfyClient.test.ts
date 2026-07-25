/**
 * ComfyClient — arrived as 428 untested lines from the Comfy-kit port. These
 * tests pin the behaviours that are expensive to get wrong at render time:
 * local-vs-cloud path prefixing, which history endpoint is polled, output
 * collection (including the SaveAudio/SaveVideo messages fallback), and the
 * error paths that used to surface as a silent 10-minute timeout.
 *
 * `fetch` is stubbed, so nothing here touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComfyClient } from '../src/comfyClient.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

let calls: Call[];
let realFetch: typeof globalThis.fetch;
const ENV_KEYS = ['COMFY_CLOUD_API_KEY', 'COMFY_MODE'] as const;
let saved: Record<string, string | undefined>;

/** Route stubbed responses by URL substring; first match wins. */
function stubFetch(routes: Array<[RegExp, () => Response]>): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    for (const [re, make] of routes) if (re.test(url)) return make();
    return new Response('not stubbed', { status: 404, statusText: 'Not Found' });
  }) as unknown as typeof globalThis.fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const LOCAL = 'http://127.0.0.1:8188';
const CLOUD = 'https://cloud.comfy.org';

describe('base URL normalization', () => {
  it('strips a trailing slash and a trailing /api so paths are applied once', async () => {
    stubFetch([[/\/prompt/, () => json({ prompt_id: 'p1' })]]);
    // A trailing /api would otherwise produce /api/api/prompt on cloud.
    await new ComfyClient(`${LOCAL}/`).queuePrompt({});
    expect(calls[0]!.url).toBe(`${LOCAL}/prompt`);

    calls = [];
    await new ComfyClient(`${LOCAL}/api`).queuePrompt({});
    expect(calls[0]!.url).toBe(`${LOCAL}/prompt`);
  });
});

describe('local vs cloud request paths', () => {
  it('local: no /api prefix, and polls classic /history', async () => {
    stubFetch([
      [/\/prompt/, () => json({ prompt_id: 'p1' })],
      [/\/history\//, () => json({ p1: { outputs: { '9': { images: [{ filename: 'a.png' }] } } } })],
    ]);
    const outs = await new ComfyClient(LOCAL).run({});
    expect(outs).toEqual([{ filename: 'a.png', subfolder: '', type: 'output' }]);
    expect(calls.map((c) => c.url)).toEqual([`${LOCAL}/prompt`, `${LOCAL}/history/p1`]);
  });

  it('cloud: /api prefix, and polls /history_v2 rather than /history', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'k-1';
    stubFetch([
      [/\/prompt/, () => json({ prompt_id: 'p1' })],
      [
        /\/history_v2\//,
        () => json({ p1: { outputs: { '9': { images: [{ filename: 'b.png' }] } } } }),
      ],
    ]);
    const outs = await new ComfyClient(CLOUD).run({});
    expect(outs).toEqual([{ filename: 'b.png', subfolder: '', type: 'output' }]);
    expect(calls.map((c) => c.url)).toEqual([
      `${CLOUD}/api/prompt`,
      `${CLOUD}/api/history_v2/p1`,
    ]);
  });

  it('sends X-API-Key to cloud.comfy.org and Bearer to a proxy host', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'k-1';
    stubFetch([[/\/prompt/, () => json({ prompt_id: 'p1' })]]);
    await new ComfyClient(CLOUD).queuePrompt({});
    expect(calls[0]!.headers['X-API-Key']).toBe('k-1');
    expect(calls[0]!.headers['Authorization']).toBeUndefined();

    calls = [];
    await new ComfyClient('https://proxy.example/comfy').queuePrompt({});
    expect(calls[0]!.headers['Authorization']).toBe('Bearer k-1');
    expect(calls[0]!.headers['X-API-Key']).toBeUndefined();
  });

  it('refuses to construct for cloud without a key, naming the missing env var', () => {
    expect(() => new ComfyClient(CLOUD)).toThrow(/COMFY_CLOUD_API_KEY is required/);
  });
});

describe('queuePrompt', () => {
  it('returns the prompt_id and sends client_id', async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ prompt_id: 'p-42' });
    }) as unknown as typeof globalThis.fetch;
    const id = await new ComfyClient(LOCAL).queuePrompt({ '1': { class_type: 'X' } });
    expect(id).toBe('p-42');
    expect(body['client_id']).toMatch(/^dhee-/);
    expect(body['prompt']).toEqual({ '1': { class_type: 'X' } });
    expect(body['extra_data']).toBeUndefined();
  });

  it('threads workflowId into extra_data for metering when supplied', async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ prompt_id: 'p1' });
    }) as unknown as typeof globalThis.fetch;
    await new ComfyClient(LOCAL).queuePrompt({}, undefined, 'wf-7');
    expect(body['extra_data']).toEqual({
      dhee_workflow_id: 'wf-7',
      workflowId: 'wf-7',
      dhee: { workflowId: 'wf-7' },
    });
  });

  it('throws with the status and body when /prompt rejects the graph', async () => {
    stubFetch([[/\/prompt/, () => new Response('bad node', { status: 400, statusText: 'Bad Request' })]]);
    await expect(new ComfyClient(LOCAL).queuePrompt({})).rejects.toThrow(
      /\/prompt failed: 400 Bad Request bad node/,
    );
  });

  it('adds a re-auth hint on 401', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'k-1';
    stubFetch([
      [/\/prompt/, () => json({ error: 'Unauthorized' }, 401)],
    ]);
    await expect(new ComfyClient(CLOUD).queuePrompt({})).rejects.toThrow(/Sign in again/);
  });

  it('throws when the response omits prompt_id', async () => {
    stubFetch([[/\/prompt/, () => json({})]]);
    await expect(new ComfyClient(LOCAL).queuePrompt({})).rejects.toThrow(/missing prompt_id/);
  });
});

describe('output collection', () => {
  const outputsFor = async (entry: unknown) => {
    stubFetch([[/\/history\//, () => json({ p1: entry })]]);
    return new ComfyClient(LOCAL).waitForOutputs('p1', { pollMs: 1 });
  };

  it('collects across every output key Comfy uses', async () => {
    const outs = await outputsFor({
      outputs: {
        '1': { images: [{ filename: 'i.png' }] },
        '2': { gifs: [{ filename: 'g.gif' }] },
        '3': { videos: [{ filename: 'v.mp4' }] },
        '4': { audio: [{ filename: 'a.flac' }] },
      },
    });
    expect(outs.map((o) => o.filename).sort()).toEqual(['a.flac', 'g.gif', 'i.png', 'v.mp4']);
  });

  it('accepts a bare object as well as an array', async () => {
    const outs = await outputsFor({ outputs: { '1': { image: { filename: 'solo.png' } } } });
    expect(outs).toEqual([{ filename: 'solo.png', subfolder: '', type: 'output' }]);
  });

  it('preserves subfolder and type', async () => {
    const outs = await outputsFor({
      outputs: { '1': { images: [{ filename: 'a.png', subfolder: 'sub/dir', type: 'temp' }] } },
    });
    expect(outs).toEqual([{ filename: 'a.png', subfolder: 'sub/dir', type: 'temp' }]);
  });

  it('keeps same-named files that differ by subfolder or type', async () => {
    // Regression: dedupe keyed on the bare filename silently dropped these.
    const outs = await outputsFor({
      outputs: {
        '1': { images: [{ filename: 'f.png', subfolder: 'a' }] },
        '2': { images: [{ filename: 'f.png', subfolder: 'b' }] },
        '3': { images: [{ filename: 'f.png', subfolder: 'a', type: 'temp' }] },
      },
    });
    expect(outs).toHaveLength(3);
  });

  it('deduplicates a genuinely identical output reported twice', async () => {
    const outs = await outputsFor({
      outputs: {
        '1': { images: [{ filename: 'f.png', subfolder: 's', type: 'output' }] },
        '2': { images: [{ filename: 'f.png', subfolder: 's', type: 'output' }] },
      },
    });
    expect(outs).toHaveLength(1);
  });

  it('falls back to status.messages when outputs is empty (SaveAudio/SaveVideo)', async () => {
    // Cloud SaveAudio/SaveVideo nodes often never populate history.outputs;
    // the saved-file info only appears in an 'executed' message.
    const outs = await outputsFor({
      status: { completed: true, messages: [['executed', { output: { audio: [{ filename: 's.flac' }] } }]] },
      outputs: {},
    });
    expect(outs).toEqual([{ filename: 's.flac', subfolder: '', type: 'output' }]);
  });

  it('ignores entries with no usable filename', async () => {
    // `completed` is required for the local path to stop polling: no outputs
    // and no completion flag legitimately means "still running".
    const outs = await outputsFor({
      status: { completed: true },
      outputs: { '1': { images: [{ subfolder: 'x' }, { filename: 7 }] } },
    });
    expect(outs).toEqual([]);
  });
});

describe('failure and completion signalling', () => {
  it('throws immediately when history reports an error status', async () => {
    stubFetch([
      [/\/history\//, () => json({ p1: { status: { status_str: 'error', messages: [['execution_error', {}]] } } })],
    ]);
    await expect(new ComfyClient(LOCAL).waitForOutputs('p1', { pollMs: 1 })).rejects.toThrow(
      /workflow errored: execution_error/,
    );
  });

  it('returns empty rather than hanging when a local run completes with no outputs', async () => {
    stubFetch([[/\/history\//, () => json({ p1: { status: { completed: true }, outputs: {} } })]]);
    await expect(new ComfyClient(LOCAL).waitForOutputs('p1', { pollMs: 1 })).resolves.toEqual([]);
  });

  it('surfaces the cloud execution exception instead of a silent timeout', async () => {
    // The headline fix in this client: a cloud graph that errored at execution
    // used to look identical to a slow cold start and burned the full timeout.
    process.env['COMFY_CLOUD_API_KEY'] = 'k-1';
    stubFetch([
      [/\/history_v2\//, () => json({ p1: {} })],
      [/\/job\/p1\/status/, () => json({ status: 'failed' })],
      [
        /\/job\/p1$/,
        () =>
          json({
            exception: {
              exception_type: 'ValueError',
              exception_message: 'lora_name not found',
              node_id: '12',
            },
          }),
      ],
    ]);
    await expect(
      new ComfyClient(CLOUD).waitForOutputs('p1', { pollMs: 1 }),
    ).rejects.toThrow(/workflow failed for prompt p1: ValueError — lora_name not found — node=12/);
  });

  it('times out with the prompt id when nothing ever lands', async () => {
    stubFetch([[/\/history\//, () => new Response('', { status: 404 })]]);
    await expect(
      new ComfyClient(LOCAL).waitForOutputs('p1', { pollMs: 1, timeoutMs: 5 }),
    ).rejects.toThrow(/timed out after 5ms waiting for prompt p1/);
  });

  it('aborts promptly when the signal fires', async () => {
    stubFetch([[/\/history\//, () => new Response('', { status: 404 })]]);
    const ac = new AbortController();
    const p = new ComfyClient(LOCAL).waitForOutputs('p1', { pollMs: 50, timeoutMs: 60_000, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });

  it('does not accumulate abort listeners across poll ticks', async () => {
    // One listener per delay() call would leak ~400 listeners over a default
    // 10-minute poll against the same long-lived signal.
    stubFetch([[/\/history\//, () => new Response('', { status: 404 })]]);
    const ac = new AbortController();
    let peak = 0;
    const orig = ac.signal.addEventListener.bind(ac.signal);
    let live = 0;
    vi.spyOn(ac.signal, 'addEventListener').mockImplementation(((...args: unknown[]) => {
      live += 1;
      peak = Math.max(peak, live);
      return orig(...(args as Parameters<typeof orig>));
    }) as typeof ac.signal.addEventListener);
    vi.spyOn(ac.signal, 'removeEventListener').mockImplementation((() => {
      live -= 1;
    }) as typeof ac.signal.removeEventListener);

    await expect(
      new ComfyClient(LOCAL).waitForOutputs('p1', { pollMs: 1, timeoutMs: 60, signal: ac.signal }),
    ).rejects.toThrow(/timed out/);
    expect(peak).toBeLessThanOrEqual(1);
  });
});

describe('download', () => {
  it('requests /view with filename, subfolder and type, then writes the bytes', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'dhee-dl-'));
    const dest = join(dir, 'out.png');
    stubFetch([[/\/view/, () => new Response(new Uint8Array([1, 2, 3]))]]);
    await new ComfyClient(LOCAL).download({ filename: 'a.png', subfolder: 'sub', type: 'temp' }, dest);
    expect(calls[0]!.url).toContain('filename=a.png');
    expect(calls[0]!.url).toContain('subfolder=sub');
    expect(calls[0]!.url).toContain('type=temp');
    expect(Array.from(readFileSync(dest))).toEqual([1, 2, 3]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws rather than writing a truncated file when the body is empty', async () => {
    stubFetch([[/\/view/, () => new Response(new Uint8Array([]))]]);
    await expect(
      new ComfyClient(LOCAL).download({ filename: 'a.png', subfolder: '', type: 'output' }, '/tmp/x'),
    ).rejects.toThrow(/downloaded file was empty/);
  });
});
