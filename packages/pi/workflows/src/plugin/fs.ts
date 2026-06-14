/**
 * The package's neutral fs facade re-export.
 *
 * The skill catalog, the source resolver, and the workflow tools all need a
 * `node:fs/promises`-backed {@link FsFacade}. Under opencode this lived as a
 * `nodeFs` re-export off `tools/workflow.ts`, forcing siblings to import across
 * the tool layer. Here it is hoisted to a leaf module with no other dependency so
 * the rewrite never threads an import through the tools.
 *
 * The implementation is core's {@link nodeFsFacade} (the one `node:fs/promises`
 * facade shared across the pi packages), aliased to the historical `nodeFs` name
 * the catalog/resolver call sites use.
 */

import { nodeFsFacade } from "@drawers/pi-core";

export { type FsFacade, nodeFsFacade } from "@drawers/pi-core";

/** Historical alias for {@link nodeFsFacade} — the package's `node:fs/promises` facade. */
export const nodeFs = nodeFsFacade;
