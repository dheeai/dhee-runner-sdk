/**
 * @dheeai/runner-sdk — the public surface a Dhee runner (and bundle author)
 * builds against. A published runner depends on ONLY this package, never
 * on kshana-core internals (enforced by the runner-sdk firewall test).
 *
 * Re-exports the canonical bundle/runner types plus the shared runtime
 * primitives (endpoint resolution, transient retry, content-hash) that
 * every comfy/network runner needs.
 */
export type {
  AggregateConfig,
  BundleDependencies,
  BundleDisplay,
  BundleInputControl,
  BundleInputDecl,
  BundleInputOption,
  BundleRequirements,
  ChunkBy,
  DagBundle,
  InputScope,
  InputUsage,
  LLMAccess,
  LLMAccessMessage,
  LLMAccessMessageRole,
  LLMAccessTier,
  LLMGenerateTextOptions,
  GenerationCacheAccess,
  LLMGenerateTextResult,
  NodeDef,
  NodeInput,
  NodeKind,
  NodeOutput,
  ProjectAccess,
  RequiredCustomNode,
  RequiredModel,
  Runner,
  RunnerArtifact,
  RunnerContext,
  RunnerDescription,
  RunnerManifest,
  RunnerPermissions,
  RunnerResult,
} from './types.js';

export { defineRunner } from './defineRunner.js';
export { isTransientError, retryTransient, type RetryOpts } from './transientRetry.js';
export { resolveEndpointUrl } from './endpointResolver.js';
export { computeInputsHash, type FileInputRef, type InputsHashKey } from './inputsHash.js';
export {
  ffmpegBin,
  ffprobeBin,
  resolveBin,
  toUnpackedPath,
  type BinResolverDeps,
} from './ffmpegBin.js';
export {
  buildComfyAuthHeaders,
  isComfyCloudUrl,
  readComfyApiKey,
  requireComfyApiKeyForCloud,
  useBearerComfyAuth,
} from './comfyAuth.js';
export {
  ComfyClient,
  type ComfyClientOptions,
  type ComfyOutput,
  type RunOpts as ComfyRunOpts,
} from './comfyClient.js';
export {
  isCloudEndpoint,
  resolveWorkflowPath,
  type ResolveWorkflowPathOpts,
} from './workflowPath.js';
export {
  injectParameter,
  pruneAndRedirect,
  type ComfyParameterMapping,
  type ComfyWorkflow,
  type PruneSpec,
} from './comfyGraph.js';
export {
  aliasEndpointKey,
  applyAliases,
  applyEndpointAliases,
  defaultAliasesDir,
  endpointSlug,
  readAliases,
  validateClassSwaps,
  writeAliases,
  type ApplyAliasesOpts,
  type ApplyEndpointAliasesOpts,
  type ApplyEndpointAliasesResult,
  type ClassSwapProblem,
  type WorkflowAliases,
} from './workflowAliases.js';
