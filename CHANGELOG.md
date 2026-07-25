# Changelog

## 0.5.0

### Added

- **`ctx.cache` (`GenerationCacheAccess`) and `ctx.project` (`ProjectAccess`)** — injected capabilities, mirroring how `ctx.llm` already works.

  This is what lets an EXTERNALIZED runner keep content-addressed caching. Until now only in-core runners could reach `GenerationCache`, so moving one out silently cost it CAS dedup — a cost regression, not a refactor. `comfy.tti` alone is 65 node references across the bundles; re-paying for identical GPU renders on every re-walk is worse than leaving the runner in core.

  The surface is deliberately narrow — `fetch(key, destAbsPath)` and `store(key, sourceAbsPath, opts)`:

  - **It never exposes the store's own paths.** A runner asks for a cached artifact at a destination it already owns, and hands over a file to be stored. It never learns where the CAS keeps things, so the engine can relocate or remote the store without breaking runners.
  - **`enabled`** is false when the operator disabled caching, so a runner can skip building a key rather than pay for a guaranteed miss.
  - **Async by contract**, though today's implementation is synchronous, so a future shared or remote cache is not a breaking change.
  - **`ProjectAccess.cacheScope`** goes into the `InputsHashKey` so two projects with identical inputs cannot share entries.

  Both are optional and a runner MUST stay correct without them: an absent cache means *recompute*, never *fail*, and `store` returning null is best-effort — a full disk must not turn a good render into a failed node.

### Fixed

- **`npm run typecheck` now covers `test/`.** The test directory sat outside the tsconfig `include`, so test files were transpiled by vitest but never type-checked. A test in this release constructed an `InputsHashKey` without its required `config` field and passed anyway; a second tsconfig (`tsconfig.test.json`) catches that class of thing now.

### Tests

116 (up from 104) — 12 covering the degradation paths that make this safe to depend on: no cache injected, cache disabled, a failing `store`, per-project scoping, key sensitivity, and that `fetch` writes to the runner's chosen destination rather than a store path.

## 0.4.0

### Added

- **`workflowAliases`** — the per-endpoint alias store, ported from dhee-core: `readAliases`, `writeAliases`, `applyAliases`, `applyEndpointAliases`, `validateClassSwaps`, `aliasEndpointKey`, `endpointSlug`, `defaultAliasesDir`.

  This is the missing piece that actually blocked externalizing the `comfy.*` runners, and it is not optional. A bundle ships a CANONICAL workflow naming the model files its author had; the operator's box usually has different ones. The alias store reconciles them. Concretely, on this dev box the live store rewrites `qwen_image_edit_2511_bf16.safetensors` → `Qwen-Image-Edit-2511-FP8_e4m3fn.safetensors` — so an externalized `comfy.qwen_edit_chain` *without* alias support would hand Comfy a filename that box does not have, and the render would fail on a missing model.

  Verified equivalent to dhee-core's implementation against the **real** alias store: identical endpoint keys, slugs and loaded aliases across local/cloud/proxy endpoints, and a byte-identical rewritten graph on the real `qwen_edit_multi.json`.

  Note the keying design, which the tests pin: every non-cloud URL collapses to one stable `self.local` key, so a tailnet rename or a LAN-IP change does not orphan the operator's model substitutions. Cloud endpoints stay keyed per host, because separate accounts have separate model libraries.

### Fixed

- **The `/object_info` probe is now bounded.** It was a bare `fetch` with no timeout and no abort signal, so an unreachable or cold-starting endpoint stalled the caller indefinitely — and because the caller swallows the failure as "validation skipped", the stall was invisible. Now capped at 5s, and `applyEndpointAliases` accepts a `signal` that is threaded through, so a cancelled run cancels the probe. Validation is best-effort by design, so skipping the check beats holding up a render.

- **Deduplicated `isCloudEndpoint`.** The ported module arrived with a byte-identical second copy of the predicate already in `workflowPath`. Two copies of the same rule is exactly the drift this package exists to prevent, so there is now one definition, re-exported.

### Tests

104 (up from 82) — 22 new, covering endpoint keying and the `self.local` collapse, store round-trip and malformed-store tolerance, model renames including the no-mutation contract, class-swap validation (missing class and unsatisfied required inputs), and `applyEndpointAliases`: that a rename-only store never touches the network, that the abort signal reaches the probe, and that a failed probe degrades rather than blocking.

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
