// Permission hook for the Agent SDK. MVP: allow-all. This is the documented
// single-file seam for later per-tool Bash gating. It introduces NO shell input
// path — the terminal pane stays a read-only replay of Claude's Bash events.
//
// The sidecar owns no Anthropic credential and selects no auth method: the SDK
// auto-detects from the inherited host environment (direct API key, Claude
// subscription/enterprise OAuth, or Bedrock). Do not add credential-selection
// code here or anywhere in the sidecar.

export interface ToolPermissionRequest {
  toolName: string;
  input: unknown;
}

export interface ToolPermissionResult {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
}

// Allow every tool in the MVP. Later, per-tool gating (e.g. Bash) hooks in here.
export function canUseTool(_request: ToolPermissionRequest): ToolPermissionResult {
  return { behavior: "allow" };
}
