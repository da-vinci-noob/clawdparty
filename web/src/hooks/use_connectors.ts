// Fetches the MCP connectors the host has configured for a session's repo from
// GET /api/sessions/:id/connectors (proxied from the sidecar, discovered at
// runtime by scanning the session's `.mcp.json` + host-wide `~/.claude`). Only
// `name` + `transport` are ever exposed — never the server's command/url/headers.
//
// Like useModels, only real discovered entries are usable: the endpoint returns an
// empty list when the source is missing/unavailable (no fake fallbacks), so the
// picker shows real connectors or nothing — never invented ones.

import type { ConnectorInfo } from "@clawdparty/contracts";
import { useQuery } from "@tanstack/react-query";

interface ConnectorList {
  connectors: ConnectorInfo[];
  source?: string;
}

async function fetchConnectors(sessionId: string): Promise<ConnectorList> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/connectors`, {
      headers: { accept: "application/json" },
      credentials: "include",
    });
    if (!res.ok) {
      return { connectors: [] };
    }
    return (await res.json()) as ConnectorList;
  } catch {
    return { connectors: [] };
  }
}

// The discovered, host-configured connectors (empty while loading or if discovery
// is unavailable). The browser can enable these by name; it can never define one.
export function useConnectors(sessionId: string): ConnectorInfo[] {
  const { data } = useQuery({
    queryKey: ["connectors", sessionId],
    queryFn: () => fetchConnectors(sessionId),
    staleTime: 60_000,
  });
  return data?.connectors ?? [];
}
