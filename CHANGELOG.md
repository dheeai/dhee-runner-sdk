# Changelog

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
