// Fetches the skills the host has installed for a session's repo from
// GET /api/sessions/:id/skills (proxied from the sidecar, discovered at runtime by
// scanning `<repo>/.claude/skills/*/SKILL.md` + `~/.claude/skills/*/SKILL.md`).
// Exposes `name` + `description` from each SKILL.md frontmatter.
//
// Like useModels, only real discovered entries are usable: the endpoint returns an
// empty list when the source is missing/unavailable (no fake fallbacks). The length
// of this list is the real installed-skill count.

import type { SkillInfo } from "@clawdparty/contracts";
import { useQuery } from "@tanstack/react-query";

interface SkillList {
  skills: SkillInfo[];
  source?: string;
}

async function fetchSkills(sessionId: string): Promise<SkillList> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/skills`, {
      headers: { accept: "application/json" },
      credentials: "include",
    });
    if (!res.ok) {
      return { skills: [] };
    }
    return (await res.json()) as SkillList;
  } catch {
    return { skills: [] };
  }
}

// The discovered, host-installed skills (empty while loading or if discovery is
// unavailable). Skills default-OFF; the browser opts a run into named skills.
export function useSkills(sessionId: string): SkillInfo[] {
  const { data } = useQuery({
    queryKey: ["skills", sessionId],
    queryFn: () => fetchSkills(sessionId),
    staleTime: 60_000,
  });
  return data?.skills ?? [];
}
