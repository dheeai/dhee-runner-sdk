# Changelog

## 0.3.0

Reconciles the SDK fork. `@dheeai` is now the canonical scope; `@dhee_ai/runner-sdk@0.1.5` had a Comfy kit that no consumer depended on, while `@dheeai` had the consumers and no kit. This release brings the kit onto the canonical scope, so one package has the whole surface. See #6.

### Added

- **`ComfyClient`** (`src/comfyClient.ts`) — shared Comfy HTTP client: `uploadFile`, `queuePrompt`, `waitForOutputs`, `download`, `run`. Handles local ComfyUI and Comfy Cloud, including the `/api` path prefix, `history_v2` vs classic `history`, the `status.messages` output fallback that SaveAudio/SaveVideo need, and surfacing a cloud `execution_error` instead of polling silently to a 10-minute timeout.
- **`comfyAuth`** — `buildComfyAuthHeaders`, `isComfyCloudUrl`, `readComfyApiKey`, `useBearerComfyAuth`, `requireComfyApiKeyForCloud`. Bearer for the dhee proxy, `X-API-Key` for `cloud.comfy.org`, no headers locally.
- **`comfyGraph`** — `pruneAndRedirect()` and `injectParameter()`, ported from dhee-core's `comfyExecutor.ts`. Pure graph edits, no transport. `pruneAndRedirect` follows redirects transitively, which is what makes pruning an optional `ReferenceLatent` chain order-independent. Verified equivalent to dhee-core's implementation across 7 cases including transitive chains, reversed redirect order, and a cyclic table.
- **`resolveWorkflowPath()` / `isCloudEndpoint()`** — cloud-aware workflow selection (`X.json` → `X_cloud.json`, `X_local.json` → `X_cloud.json`, explicit `workflowPathCloud` wins). Without it a runner ships local model filenames to Comfy Cloud and the job fails with no outputs.
- **`NodeDef.allowEmptyItems`** — lets the walker materialize zero instances for an optional collection instead of treating an empty source array as malformed upstream output.

### Changed

- `resolveEndpointUrl` now falls back to `COMFYUI_BASE_URL` in cloud mode when the specific `ENDPOINT_<name>` is unset — symmetric with the local branch, which already did. Previously, adding a new bundle endpoint label silently broke cloud routing until an operator added the matching env var.

### Fixed (defects found while reviewing the ported code, not present upstream)

- **Abort-listener leak in `ComfyClient`.** `delay()` registered an `abort` listener per poll tick and only removed it if the abort actually fired, so a default 10-minute wait accumulated ~400 listeners on one long-lived signal. Now removed on the normal path.
- **Output dedupe dropped distinct files.** `collectOutputs` keyed on the bare filename, so the same basename in two subfolders — or the same name as both `output` and `temp` — silently lost one. Now keyed on `type + subfolder + filename`.
- `RunOpts.timeoutMs` documented honestly: it budgets waiting for the *job*, and cloud output resolution gets its own ~90 s on top, so a cloud call can run to roughly `timeoutMs + 90 s`. `signal` is the hard stop.

### Tests

82 tests (up from 17), covering the Comfy client's local/cloud path split, auth scheme selection, output collection and dedupe, every failure path, abort behaviour, and graph pruning. `ComfyClient` arrived as 428 untested lines; it is no longer untested.

### Known gap

This is **not** a full replacement for dhee-core's `comfyExecutor.ts` yet. Still core-only: CAS caching (needs #4), the Comfy Cloud workflow alias store (see dheeai/dhee-core#178), and the declarative `parameterMappings` / `manifestPath` orchestration layer. Tracked in #3.

## 0.2.0

### Added

- **`ffmpegBin()` / `ffprobeBin()`** — resolve the ffmpeg / ffprobe executable a runner should spawn, instead of a bare `'ffmpeg'`.

  A bare spawn assumes a system ffmpeg on `PATH`, which does not exist on a clean Windows box, in CI without ffmpeg installed, or inside a macOS GUI app that never inherited the shell `PATH`. `dhee-core` fixed this internally long ago and the fix never reached the published runners — a survey of the runner ecosystem found **39 bare-`ffmpeg` spawn sites and zero runners depending on an ffmpeg installer package**. This is that resolver, lifted into the SDK so every runner can share it.

  Resolution order: `dhee_FFMPEG_PATH` / `dhee_FFPROBE_PATH` env override → bundled installer binary (`chmod +x` if the package manager stripped execute bits; `app.asar` → `app.asar.unpacked` for packaged Electron) → bare name on `PATH`. Verified behaviourally equivalent to the `dhee-core` implementation it replaces across the override, blank-override, padded-override, and no-override cases.

  `@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` are declared as **optional peer dependencies**: the SDK provides the resolver, your runner provides the binaries. A runner that never touches ffmpeg pays nothing for ~80 MB of platform binaries. See the README's "Spawning ffmpeg" section.

  Also exported: `resolveBin()` for a differently-named binary, `toUnpackedPath()` for the asar rewrite, and the `BinResolverDeps` seam the tests inject through.

- **A test suite.** The package had none. `npm test` runs vitest; CI now runs it alongside build + typecheck.

Unblocks the externalization of the five `ffmpeg.*` runners still inside `dhee-core` (dheeai/dhee-core#195), which could not move out without a resolver to move onto.

## 0.1.1

- Validate OIDC trusted publishing.

## 0.1.0

- Initial release: `defineRunner`, `resolveEndpointUrl`, `retryTransient` / `isTransientError`, `computeInputsHash`, and the canonical bundle/runner types.
