/**
 * Resolve the ffmpeg / ffprobe executables a runner spawns.
 *
 * A runner that shells out to ffmpeg must NOT spawn a bare `'ffmpeg'`: that
 * assumes a system ffmpeg on PATH, which does not exist on a clean Windows
 * box, in CI without ffmpeg installed, or inside a macOS GUI app that never
 * inherited the shell PATH. The failure mode is `spawn ffmpeg ENOENT` at
 * render time — late, and on someone else's machine.
 *
 * dhee-core solved this internally and the fix never reached the published
 * runners. This is that resolver, lifted into the SDK so every runner gets
 * it. Resolution order:
 *
 *   1. `dhee_FFMPEG_PATH` / `dhee_FFPROBE_PATH` env override — lets a host
 *      (the desktop) or a power user pin a specific binary.
 *   2. The bundled `@ffmpeg-installer/ffmpeg` / `@ffprobe-installer/ffprobe`
 *      binary (chmod +x if the package manager stripped execute bits). Inside
 *      a packaged Electron app the installer path points into `app.asar`
 *      (read-only, not executable) — rewrite it to the unpacked sibling.
 *   3. Bare `ffmpeg` / `ffprobe` on PATH (dev / CI fallback).
 *
 * The installer packages are declared as OPTIONAL peer dependencies, so the
 * split of responsibility is: the SDK provides the resolver, the runner
 * provides the binaries. A runner that spawns ffmpeg installs
 * `@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` itself and step 2
 * fires; a runner that never touches ffmpeg pays nothing for ~80 MB of
 * platform binaries, and step 2 degrades quietly to step 3 because the
 * `require` failure is caught.
 */
import { accessSync, chmodSync, constants } from 'node:fs';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/**
 * Filesystem + module-loading seams, injected so the resolution order is
 * testable without a real binary on disk. Not part of the public API —
 * `ffmpegBin()` / `ffprobeBin()` supply the real implementations.
 */
export interface BinResolverDeps {
  /** Read an env var. */
  getEnv: (key: string) => string | undefined;
  /** Load a module and return its `.path` export, or throw if absent. */
  requireModule: (pkg: string) => unknown;
  /** True when the path is executable. */
  isExecutable: (path: string) => boolean;
  /** Best-effort chmod 0o755; returns true when it succeeded. */
  makeExecutable: (path: string) => boolean;
}

const realDeps: BinResolverDeps = {
  getEnv: (key) => process.env[key],
  requireModule: (pkg) => nodeRequire(pkg),
  isExecutable: (path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  makeExecutable: (path) => {
    try {
      chmodSync(path, 0o755);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Rewrite an `app.asar` path to its `app.asar.unpacked` sibling.
 *
 * Node's patched `fs` sees through an asar archive, so `existsSync` returns
 * true for a path inside it — but the binary is executed by the OS, which has
 * no idea what an asar is. The real bytes live in the unpacked sibling.
 * Idempotent: a path already containing `app.asar.unpacked` is returned
 * unchanged, so repeated application cannot corrupt it.
 */
export function toUnpackedPath(path: string): string {
  if (path.includes('app.asar') && !path.includes('app.asar.unpacked')) {
    return path.replace('app.asar', 'app.asar.unpacked');
  }
  return path;
}

/** Return `path` when executable, chmod'ing once if needed; null when unusable. */
function ensureUsableBin(path: string, deps: BinResolverDeps): string | null {
  if (deps.isExecutable(path)) return path;
  if (deps.makeExecutable(path) && deps.isExecutable(path)) return path;
  return null;
}

/** Read `.path` from an `@*-installer` package, asar-corrected. null if absent. */
function installerPath(pkg: string, deps: BinResolverDeps): string | null {
  let mod: unknown;
  try {
    mod = deps.requireModule(pkg);
  } catch {
    // Optional dependency not installed — fall through to the PATH fallback.
    return null;
  }
  const raw = (mod as { path?: unknown } | undefined)?.path;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return toUnpackedPath(raw);
}

/**
 * The resolution order, with its dependencies made explicit. Exported for
 * tests and for a runner that needs to resolve a differently-named binary;
 * prefer `ffmpegBin()` / `ffprobeBin()`.
 */
export function resolveBin(
  envKey: string,
  installerPkg: string,
  bareFallback: string,
  deps: BinResolverDeps = realDeps,
): string {
  const override = deps.getEnv(envKey);
  if (override && override.trim()) return override.trim();

  const installed = installerPath(installerPkg, deps);
  if (installed) return ensureUsableBin(installed, deps) ?? bareFallback;

  return bareFallback;
}

/**
 * Absolute path to an ffmpeg binary, or the bare name `'ffmpeg'` when only a
 * PATH lookup is available. Always prefer this over spawning `'ffmpeg'`.
 */
export function ffmpegBin(deps: BinResolverDeps = realDeps): string {
  return resolveBin('dhee_FFMPEG_PATH', '@ffmpeg-installer/ffmpeg', 'ffmpeg', deps);
}

/**
 * Absolute path to an ffprobe binary, or the bare name `'ffprobe'` when only a
 * PATH lookup is available. Always prefer this over spawning `'ffprobe'`.
 */
export function ffprobeBin(deps: BinResolverDeps = realDeps): string {
  return resolveBin('dhee_FFPROBE_PATH', '@ffprobe-installer/ffprobe', 'ffprobe', deps);
}
