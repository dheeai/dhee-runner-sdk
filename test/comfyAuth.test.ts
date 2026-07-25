import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildComfyAuthHeaders,
  isComfyCloudUrl,
  readComfyApiKey,
  requireComfyApiKeyForCloud,
  useBearerComfyAuth,
} from '../src/comfyAuth.js';

const ENV_KEYS = ['COMFY_CLOUD_API_KEY', 'COMFY_MODE'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('isComfyCloudUrl', () => {
  it('matches cloud.comfy.org on any scheme or path, case-insensitively', () => {
    expect(isComfyCloudUrl('https://cloud.comfy.org')).toBe(true);
    expect(isComfyCloudUrl('https://cloud.comfy.org/api/prompt')).toBe(true);
    expect(isComfyCloudUrl('http://CLOUD.COMFY.ORG')).toBe(true);
  });

  it('does not match a different host, a subdomain, or a lookalike', () => {
    expect(isComfyCloudUrl('https://comfy.org')).toBe(false);
    expect(isComfyCloudUrl('https://evil-cloud.comfy.org.attacker.com')).toBe(false);
    expect(isComfyCloudUrl('http://127.0.0.1:8188')).toBe(false);
  });

  it('returns false rather than throwing on an unparseable value', () => {
    expect(isComfyCloudUrl('not a url')).toBe(false);
    expect(isComfyCloudUrl('')).toBe(false);
  });
});

describe('readComfyApiKey', () => {
  it('reads and trims COMFY_CLOUD_API_KEY', () => {
    process.env['COMFY_CLOUD_API_KEY'] = '  k-123  ';
    expect(readComfyApiKey()).toBe('k-123');
  });

  it('treats unset and whitespace-only as absent', () => {
    expect(readComfyApiKey()).toBeUndefined();
    process.env['COMFY_CLOUD_API_KEY'] = '   ';
    expect(readComfyApiKey()).toBeUndefined();
  });
});

describe('buildComfyAuthHeaders', () => {
  it('sends no auth at all when there is no key', () => {
    expect(buildComfyAuthHeaders('http://127.0.0.1:8188')).toEqual({});
    expect(buildComfyAuthHeaders('https://cloud.comfy.org')).toEqual({});
  });

  it('uses Bearer for the dhee proxy (any host that is not cloud.comfy.org)', () => {
    expect(buildComfyAuthHeaders('https://dhee.studio/comfy/api', 'k-1')).toEqual({
      Authorization: 'Bearer k-1',
    });
  });

  it('uses X-API-Key when talking directly to cloud.comfy.org', () => {
    // The two cloud paths take DIFFERENT header schemes; swapping them is a
    // silent 401, so this distinction is the point of the module.
    expect(buildComfyAuthHeaders('https://cloud.comfy.org/api', 'k-1')).toEqual({
      'X-API-Key': 'k-1',
    });
  });

  it('prefers an explicit key over the environment', () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'from-env';
    expect(buildComfyAuthHeaders('https://cloud.comfy.org', 'explicit')).toEqual({
      'X-API-Key': 'explicit',
    });
  });

  it('falls back to the environment key when none is passed', () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'from-env';
    expect(buildComfyAuthHeaders('https://proxy.example/comfy/api')).toEqual({
      Authorization: 'Bearer from-env',
    });
  });
});

describe('useBearerComfyAuth', () => {
  it('is true only when a key exists and the host is not cloud.comfy.org', () => {
    expect(useBearerComfyAuth('https://proxy.example', 'k')).toBe(true);
    expect(useBearerComfyAuth('https://cloud.comfy.org', 'k')).toBe(false);
    expect(useBearerComfyAuth('https://proxy.example')).toBe(false);
  });
});

describe('requireComfyApiKeyForCloud', () => {
  it('throws when COMFY_MODE=cloud but no key is configured', () => {
    process.env['COMFY_MODE'] = 'cloud';
    expect(() => requireComfyApiKeyForCloud('http://127.0.0.1:8188')).toThrow(
      /COMFY_CLOUD_API_KEY is required/,
    );
  });

  it('throws when the URL is cloud.comfy.org but no key is configured', () => {
    expect(() => requireComfyApiKeyForCloud('https://cloud.comfy.org')).toThrow(
      /COMFY_CLOUD_API_KEY is required/,
    );
  });

  it('passes for a local endpoint with no key — the common case', () => {
    expect(() => requireComfyApiKeyForCloud('http://127.0.0.1:8188')).not.toThrow();
  });

  it('passes for cloud once a key is supplied', () => {
    process.env['COMFY_MODE'] = 'cloud';
    expect(() => requireComfyApiKeyForCloud('https://cloud.comfy.org', 'k')).not.toThrow();
  });
});
