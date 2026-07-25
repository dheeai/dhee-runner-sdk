/**
 * Comfy workflow-graph manipulation — the pure, transport-free half of
 * driving a Comfy workflow. `ComfyClient` moves bytes; this shapes the graph
 * before it is queued.
 *
 * Ported from dhee-core's `dag/runners/comfyExecutor.ts` so external runners
 * get the same graph semantics the engine's built-in comfy runners have. Both
 * functions here are pure: no fs, no network, no env.
 */

/**
 * A Comfy API-format workflow: node id → node. Links between nodes are
 * `[nodeId, slotIndex]` tuples sitting in `inputs`.
 */
export type ComfyWorkflow = Record<
  string,
  { inputs: Record<string, unknown>; class_type?: string }
>;

/** Declarative "put this value into that node's field" instruction. */
export interface ComfyParameterMapping {
  /** Node id in the workflow graph. */
  nodeId: string;
  /** Field name within that node's `inputs`. */
  field: string;
  /** Logical input name, used only for error messages. */
  input?: string;
}

/**
 * Set `value` at `mapping.nodeId`.inputs[`mapping.field`].
 *
 * Returns an error result rather than throwing when the node is absent, and
 * names the node id — a workflow edited upstream (a node deleted or renumbered)
 * is the common cause, and a silent no-op there produces a render that looks
 * fine but ignored the parameter.
 */
export function injectParameter(
  workflow: ComfyWorkflow,
  mapping: ComfyParameterMapping,
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  const node = workflow[mapping.nodeId];
  if (!node) {
    const which = mapping.input ? ` (input '${mapping.input}')` : '';
    return {
      ok: false,
      error:
        `parameterMapping refers to nodeId '${mapping.nodeId}'${which} but that node is ` +
        `not in the workflow.`,
    };
  }
  node.inputs[mapping.field] = value;
  return { ok: true };
}

/** What to delete, and where consumers of a deleted node should point instead. */
export interface PruneSpec {
  /** Node ids to remove from the graph. */
  deleteNodes: string[];
  /** `from`'s consumers should consume `to`'s output instead. */
  redirects: Array<{ from: string; to: string }>;
}

/**
 * Delete `deleteNodes` from the workflow and repoint any surviving link that
 * referenced a deleted node's output at a surviving node, following
 * `redirects` transitively.
 *
 * Transitivity is the important part: if `to` is itself being deleted in the
 * same pass, the closure resolves onward to the first surviving target. That
 * makes pruning a *chain* order-independent and hole-tolerant — dropping
 * references 3 and 4 lets their consumers fall back to reference 2 in one pass,
 * which is exactly what a `ReferenceLatent` chain with optional slots needs.
 *
 * The ALGORITHM is workflow-agnostic. The node-id TABLE is workflow-specific
 * and belongs in the runner that owns the workflow — pass it in as `spec`.
 *
 * Mutates `workflow` in place and returns the set of ids actually deleted.
 */
export function pruneAndRedirect(workflow: ComfyWorkflow, spec: PruneSpec): Set<string> {
  const direct = new Map<string, string>();
  for (const r of spec.redirects) direct.set(r.from, r.to);

  // Walk the redirect chain to its end. The `seen` guard makes a cyclic
  // redirect table terminate (returning where the cycle closes) instead of
  // hanging the runner.
  const resolveFinal = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    while (direct.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = direct.get(cur)!;
    }
    return cur;
  };

  const del = new Set(spec.deleteNodes);
  for (const [nid, node] of Object.entries(workflow)) {
    if (del.has(nid)) continue;
    for (const [field, val] of Object.entries(node.inputs)) {
      // ComfyUI links are [nodeId, slotIndex] tuples.
      if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
        const finalTarget = resolveFinal(val[0]);
        if (finalTarget !== val[0]) node.inputs[field] = [finalTarget, val[1]];
      }
    }
  }
  for (const nid of del) delete workflow[nid];
  return del;
}
