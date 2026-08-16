import type { Capabilities } from "../providers/contract.js";
import { type ToolDefinition, textResult } from "./registry.js";

/**
 * `web_search` and `web_fetch` — SERVER-SIDE tools. The provider executes them;
 * the harness only declares them.
 *
 * Both are GATED on `capabilities().serverSideTools`, which is the point of this
 * file. These are NOT uniform across providers: Bedrock has neither, so declaring
 * them unconditionally would send a tool the provider rejects, and the failure
 * would surface as an opaque request error rather than as "this provider cannot
 * search the web" (R4).
 *
 * `ReplayPolicy: "safe"` — idempotent reads. Since execution is server-side, the
 * local `run` is never called; it exists so an accidental local dispatch fails
 * loudly instead of silently returning nothing.
 */

export const WEB_SEARCH_TOOL_TYPE = "web_search_20260209";
export const WEB_FETCH_TOOL_TYPE = "web_fetch_20260209";

const serverSideOnly = (name: string) =>
  textResult(
    `${name} executes on the provider, not in the harness. A local dispatch means the loop treated a server-side tool as a local one.`,
    true,
  );

export const webSearch: ToolDefinition = {
  name: "web_search",
  replay: "safe",
  schema: { type: WEB_SEARCH_TOOL_TYPE, name: "web_search" },
  requires: (caps: Capabilities) => caps.serverSideTools.webSearch,
  run: async () => serverSideOnly("web_search"),
};

export const webFetch: ToolDefinition = {
  name: "web_fetch",
  replay: "safe",
  schema: { type: WEB_FETCH_TOOL_TYPE, name: "web_fetch" },
  requires: (caps: Capabilities) => caps.serverSideTools.webFetch,
  run: async () => serverSideOnly("web_fetch"),
};

export const definitions: ToolDefinition[] = [webSearch, webFetch];
