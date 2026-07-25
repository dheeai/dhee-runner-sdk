/**
 * workflowPath — cloud-aware resolution of a bundle-declared Comfy
 * `workflowPath` to an absolute file path.
 *
 * Ported from dhee-core's `dag/workflowPathResolver` + the
 * `isCloudEndpoint` helper so external runners (which depend on
 * @dheeai/runner-sdk, NOT dhee-core) get the SAME `_cloud.json`
 * auto-selection the engine's comfyExecutor uses. Without this, a runner
 * that reads its `workflowPath` literally ships a LOCAL workflow (local
 * model filenames, e.g. `ideogram4_nvfp4_mixed.safetensors`) to Comfy
 * Cloud — where those models don't exist — and the job fails with no
 * outputs. That is the exact regression this was added to prevent.
 *
 * Cloud variant selection (first match wins):
 *   1. explicit `workflowPathCloud` (if it resolves under bundleDir), else
 *   2. convention: `..._local.json` → `..._cloud.json`, else
 *   3. convention: `X.json` → `X_cloud.json`.
 * Falls back to the canonical path whenever no cloud candidate resolves —
 * so runners/bundles without a cloud variant are completely unaffected.
 *
 * Resolution is bundleDir-relative (absolute paths pass through). External
 * runners always receive `ctx.bundleDir`, so there is no REPO_ROOT fallback
 * (unlike dhee-core's in-repo variant, which has one for headless scripts).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** True iff the endpoint URL targets Comfy Cloud (direct or via the dhee proxy). */
export function isCloudEndpoint(endpoint: string): boolean {
  return /cloud\.comfy\.org/i.test(endpoint) || /\/comfy\/api(?:\/|$)/i.test(endpoint);
}

export interface ResolveWorkflowPathOpts {
  /** Canonical (typically local) workflow path — bundle-relative or absolute. */
  workflowPath: string;
  /** ctx.bundleDir — the root used to resolve bundle-relative paths. */
  bundleDir?: string;
  /**
   * Resolved endpoint URL (from `resolveEndpointUrl`). When this is a Comfy
   * Cloud endpoint, a cloud variant is preferred. Omit/undefined to disable
   * cloud routing entirely.
   */
  endpointUrl?: string;
  /** Explicit cloud variant path. Wins over the `_local→_cloud` convention. */
  workflowPathCloud?: string;
}

/** True when `relOrAbs` resolves to an existing file under bundleDir (or is absolute + exists). */
function resolvesExisting(relOrAbs: string, bundleDir?: string): boolean {
  if (relOrAbs.startsWith('/')) return existsSync(relOrAbs);
  if (bundleDir && existsSync(resolve(bundleDir, relOrAbs))) return true;
  return false;
}

function resolveAbsolute(relOrAbs: string, bundleDir?: string): string {
  if (relOrAbs.startsWith('/')) return relOrAbs;
  return resolve(bundleDir ?? '.', relOrAbs);
}

/**
 * Resolve a bundle-declared workflowPath to an absolute file path, preferring
 * a cloud variant when the endpoint is Comfy Cloud. See module doc.
 */
export function resolveWorkflowPath(opts: ResolveWorkflowPathOpts): string {
  const { workflowPath, bundleDir, endpointUrl, workflowPathCloud } = opts;
  let chosen = workflowPath;
  if (endpointUrl && isCloudEndpoint(endpointUrl)) {
    if (workflowPathCloud && resolvesExisting(workflowPathCloud, bundleDir)) {
      chosen = workflowPathCloud;
    } else {
      // Convention 1: explicit _local.json → _cloud.json
      const derivedLocal = workflowPath.replace(/_local(?=\.json$)/, '_cloud');
      if (derivedLocal !== workflowPath && resolvesExisting(derivedLocal, bundleDir)) {
        chosen = derivedLocal;
      } else {
        // Convention 2: any X.json → X_cloud.json (for workflows without
        // the _local suffix, e.g. ideogram4.json → ideogram4_cloud.json)
        const derivedSuffix = workflowPath.replace(/\.json$/, '_cloud.json');
        if (derivedSuffix !== workflowPath && resolvesExisting(derivedSuffix, bundleDir)) {
          chosen = derivedSuffix;
        }
      }
    }
  }
  return resolveAbsolute(chosen, bundleDir);
}
