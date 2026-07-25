# @dheeai/runner-sdk

The public authoring SDK for [Dhee](https://github.com/dheeai) **runners** and **bundles**.

`dhee-core` is a content-agnostic DAG engine that walks a *bundle* (a pipeline graph) and executes each node with a *runner* (a node executor). Runners ship as standalone npm packages the engine discovers at runtime — and they depend on **this package only**, never on `dhee-core` internals. That firewall lets the engine evolve without breaking the ecosystem, and lets you build, test, and publish a runner in isolation.

## Install

```sh
npm install @dheeai/runner-sdk
```

## What it gives you

- **`defineRunner(impl)`** — wrap your `{ describe, run }` into a `Runner`.
- **`resolveEndpointUrl(name)`** — resolve a named endpoint (`self.local`, `self.cloud`, …) to its URL from the user's env (`ENDPOINT_<name>` / `COMFYUI_BASE_URL`). Keeps endpoint URLs out of bundles.
- **`retryTransient(fn, opts)` / `isTransientError(e)`** — retry network/Comfy calls with backoff + abort support.
- **`computeInputsHash(key)`** — content-addressed cache key for a node's inputs.
- **`ffmpegBin()` / `ffprobeBin()`** — resolve the ffmpeg / ffprobe executable to spawn. See below.
- The canonical **types**: `Runner`, `RunnerContext`, `RunnerDescription`, `RunnerManifest`, `RunnerResult`, `RunnerArtifact`, `DagBundle`, `NodeDef`, and the bundle/LLM-access types.

## Spawning ffmpeg

**Never spawn a bare `'ffmpeg'`.** It assumes a system ffmpeg on `PATH`, which does not exist on a clean Windows box, in CI without ffmpeg installed, or inside a macOS GUI app that never inherited the shell `PATH`. The failure is `spawn ffmpeg ENOENT` at render time — on someone else's machine.

Use the resolver instead:

```ts
import { ffmpegBin, ffprobeBin } from '@dheeai/runner-sdk';

spawn(ffmpegBin(), ['-i', input, ...args]);
```

Resolution order:

1. `dhee_FFMPEG_PATH` / `dhee_FFPROBE_PATH` env override — lets a host (the desktop) or a power user pin a specific binary.
2. The bundled installer binary, `chmod +x`'d if the package manager stripped execute bits, and rewritten from `app.asar` to `app.asar.unpacked` when running inside a packaged Electron app.
3. Bare `ffmpeg` / `ffprobe` on `PATH`.

**If your runner spawns ffmpeg, add the binaries to your own dependencies** so step 2 can fire:

```sh
npm install @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe
```

They are declared here as *optional* peer dependencies: the SDK provides the resolver, your runner provides the binaries. That way a runner that never touches ffmpeg doesn't pay for ~80 MB of platform binaries, and one that does gets a real executable on every platform.

## Minimal runner

```ts
import { defineRunner, resolveEndpointUrl, retryTransient } from '@dheeai/runner-sdk';
import type { RunnerContext, RunnerDescription, RunnerManifest } from '@dheeai/runner-sdk';

export const manifest = {
  tool: 'my.thing',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  credentials: [],
  displayName: 'My Thing',
  description: 'Does a thing.',
  entry: 'dist/index.js',
  permissions: { network: ['<host>'], filesystem: 'project', subprocess: false, env: [] },
} satisfies RunnerManifest;

const describe = (): RunnerDescription => ({
  id: manifest.tool,
  displayName: 'My Thing',
  description: 'Does a thing.',
  capabilities: ['example'],
  modalities: { input: ['text'], output: ['image'] },
  configSchema: { type: 'object', required: ['outputPath'], properties: { outputPath: { type: 'string' } } },
});

async function run(ctx: RunnerContext) {
  // ... do work, write ctx.node.runner.config.outputPath under ctx.projectDir ...
  return { ok: true, outputPath: 'out.png' };
}

export const runner = defineRunner({ describe, run });

// Discovery entry — package.json "dhee.runners" points here.
export const runners = [{ manifest, runner }];
```

## Discovery (how dhee-core finds your runner)

Your package opts in via **name + keyword + entry point**:

```jsonc
{
  "name": "dhee-runner-my-thing",
  "keywords": ["dhee-runner"],
  "dhee": { "runners": "./dist/index.js" },
  "dependencies": { "@dheeai/runner-sdk": "^0.1.0" }
}
```

`npm create dhee-runner` scaffolds all of this for you.

## License

Apache-2.0
