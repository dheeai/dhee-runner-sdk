import { describe, expect, it } from 'vitest';
import {
  ffmpegBin,
  ffprobeBin,
  resolveBin,
  toUnpackedPath,
  type BinResolverDeps,
} from '../src/ffmpegBin.js';

/**
 * Build a deps stub. Everything defaults to "nothing available", so each test
 * opts into exactly the condition it is exercising and an unset expectation
 * reads as absent rather than as an accident.
 */
function stubDeps(over: Partial<BinResolverDeps> = {}): BinResolverDeps & {
  chmodCalls: string[];
} {
  const chmodCalls: string[] = [];
  return {
    chmodCalls,
    getEnv: () => undefined,
    requireModule: () => {
      throw new Error('MODULE_NOT_FOUND');
    },
    isExecutable: () => false,
    makeExecutable: (p) => {
      chmodCalls.push(p);
      return false;
    },
    ...over,
  };
}

describe('resolveBin — step 1: env override', () => {
  it('wins over an installed binary', () => {
    const got = resolveBin(
      'MY_FFMPEG',
      '@ffmpeg-installer/ffmpeg',
      'ffmpeg',
      stubDeps({
        getEnv: (k) => (k === 'MY_FFMPEG' ? '/opt/pinned/ffmpeg' : undefined),
        requireModule: () => ({ path: '/node_modules/installer/ffmpeg' }),
        isExecutable: () => true,
      }),
    );
    expect(got).toBe('/opt/pinned/ffmpeg');
  });

  it('trims surrounding whitespace', () => {
    const got = resolveBin(
      'MY_FFMPEG',
      'pkg',
      'ffmpeg',
      stubDeps({ getEnv: () => '  /opt/ffmpeg \n' }),
    );
    expect(got).toBe('/opt/ffmpeg');
  });

  it('is ignored when set to empty or whitespace-only', () => {
    for (const value of ['', '   ']) {
      const got = resolveBin('MY_FFMPEG', 'pkg', 'ffmpeg', stubDeps({ getEnv: () => value }));
      expect(got).toBe('ffmpeg');
    }
  });
});

describe('resolveBin — step 2: bundled installer binary', () => {
  it('returns the installer path when already executable, without chmod', () => {
    const deps = stubDeps({
      requireModule: () => ({ path: '/nm/@ffmpeg-installer/bin/ffmpeg' }),
      isExecutable: () => true,
    });
    expect(resolveBin('E', 'pkg', 'ffmpeg', deps)).toBe('/nm/@ffmpeg-installer/bin/ffmpeg');
    expect(deps.chmodCalls).toEqual([]);
  });

  it('chmods once when the execute bit was stripped, then returns the path', () => {
    let executable = false;
    const deps = stubDeps({
      requireModule: () => ({ path: '/nm/bin/ffmpeg' }),
      isExecutable: () => executable,
      makeExecutable: (p) => {
        deps.chmodCalls.push(p);
        executable = true;
        return true;
      },
    });
    expect(resolveBin('E', 'pkg', 'ffmpeg', deps)).toBe('/nm/bin/ffmpeg');
    expect(deps.chmodCalls).toEqual(['/nm/bin/ffmpeg']);
  });

  it('falls back to the bare name when the binary cannot be made executable', () => {
    const deps = stubDeps({
      requireModule: () => ({ path: '/nm/bin/ffmpeg' }),
      isExecutable: () => false,
      makeExecutable: () => false,
    });
    expect(resolveBin('E', 'pkg', 'ffmpeg', deps)).toBe('ffmpeg');
  });

  it('ignores an installer module whose .path is missing or not a string', () => {
    for (const mod of [undefined, {}, { path: 42 }, { path: '' }, { path: null }]) {
      const got = resolveBin('E', 'pkg', 'ffprobe', stubDeps({ requireModule: () => mod }));
      expect(got).toBe('ffprobe');
    }
  });
});

describe('resolveBin — step 3: PATH fallback', () => {
  it('returns the bare name when the optional installer is not installed', () => {
    // The default stub throws MODULE_NOT_FOUND — the shape of an SDK consumer
    // that never installed the optional ffmpeg installer packages.
    expect(resolveBin('E', '@ffmpeg-installer/ffmpeg', 'ffmpeg', stubDeps())).toBe('ffmpeg');
  });

  it('does not let a throwing require escape', () => {
    const deps = stubDeps({
      requireModule: () => {
        throw new TypeError('exotic loader failure');
      },
    });
    expect(() => resolveBin('E', 'pkg', 'ffmpeg', deps)).not.toThrow();
  });
});

describe('toUnpackedPath — packaged Electron', () => {
  it('rewrites an app.asar path to the unpacked sibling', () => {
    expect(toUnpackedPath('/Applications/D.app/Contents/Resources/app.asar/node_modules/x/ffmpeg')).toBe(
      '/Applications/D.app/Contents/Resources/app.asar.unpacked/node_modules/x/ffmpeg',
    );
  });

  it('is idempotent — an already-unpacked path is untouched', () => {
    const unpacked = '/A/Contents/Resources/app.asar.unpacked/node_modules/x/ffmpeg';
    expect(toUnpackedPath(unpacked)).toBe(unpacked);
    expect(toUnpackedPath(toUnpackedPath(unpacked))).toBe(unpacked);
  });

  it('leaves a path with no asar segment alone', () => {
    expect(toUnpackedPath('/usr/local/bin/ffmpeg')).toBe('/usr/local/bin/ffmpeg');
  });

  it('is applied to the installer path during resolution', () => {
    const got = resolveBin(
      'E',
      'pkg',
      'ffmpeg',
      stubDeps({
        requireModule: () => ({ path: '/A/Resources/app.asar/nm/bin/ffmpeg' }),
        isExecutable: () => true,
      }),
    );
    expect(got).toBe('/A/Resources/app.asar.unpacked/nm/bin/ffmpeg');
  });
});

describe('ffmpegBin / ffprobeBin', () => {
  it('read the documented env override keys', () => {
    const seen: string[] = [];
    const deps = stubDeps({
      getEnv: (k) => {
        seen.push(k);
        return undefined;
      },
    });
    ffmpegBin(deps);
    ffprobeBin(deps);
    expect(seen).toEqual(['dhee_FFMPEG_PATH', 'dhee_FFPROBE_PATH']);
  });

  it('request the ffmpeg and ffprobe installer packages respectively', () => {
    const seen: string[] = [];
    const deps = stubDeps({
      requireModule: (pkg) => {
        seen.push(pkg);
        throw new Error('MODULE_NOT_FOUND');
      },
    });
    ffmpegBin(deps);
    ffprobeBin(deps);
    expect(seen).toEqual(['@ffmpeg-installer/ffmpeg', '@ffprobe-installer/ffprobe']);
  });

  it('never return an empty string — a spawnable value is always produced', () => {
    expect(ffmpegBin(stubDeps())).toBe('ffmpeg');
    expect(ffprobeBin(stubDeps())).toBe('ffprobe');
  });

  it('resolve against the real environment without throwing', () => {
    // No stub: exercises the actual fs + require seams on this machine.
    expect(ffmpegBin()).toBeTruthy();
    expect(ffprobeBin()).toBeTruthy();
  });
});
