import { type FC, type FormEvent, useState } from "react";
import { useCurrentParticipant } from "../../hooks/use_current_participant";
import { type SkillScope, useManageSkills } from "../../hooks/use_manage_skills";
import { useSkills } from "../../hooks/use_skills";

// Settings → Skills setup. The write half of the settings surface, and the app's only writes
// outside a session worktree.
//
// A skill is INSTRUCTIONS CLAUDE WILL FOLLOW, so this screen is deliberately not a document editor:
//   * writes are owner-only (the server's `manage_session` gate; the client only hides the controls),
//   * the destination is an explicit choice, never implied, because a HOST skill reaches every
//     session on this machine — including the developer's own terminal Claude Code,
//   * "remove" says what it really does (moves aside), since the directory is renamed and stays on
//     disk, and promising deletion would be a lie in the other direction.

const SCOPE_NOTE: Record<SkillScope, string> = {
  project: "this repo only — lands in the session's .claude/skills",
  host: "EVERY session on this machine, and your own terminal Claude Code — lands in ~/.claude/skills",
};

export const SkillsTab: FC<{ sessionId: string }> = ({ sessionId }) => {
  const skills = useSkills(sessionId);
  const { can } = useCurrentParticipant();
  const { add, removeSkill, busy, error, clearError } = useManageSkills(sessionId);
  const mayWrite = can("manage_session");

  const [scope, setScope] = useState<SkillScope>("project");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    clearError();
    setNote(null);
    try {
      await add({ scope, name: name.trim(), description: description.trim(), body });
      setNote(`Added ${name.trim()} (${scope})`);
      setName("");
      setDescription("");
      setBody("");
    } catch {
      // Surfaced by `error` from the hook — the server's message is the actionable part.
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-[12px] text-[#6b726b]">
        Skills are markdown instructions Claude loads on demand. The list below is what this session
        can see: the repo’s <code className="text-[#aeb4ae]">.claude/skills</code> plus the host’s.
      </p>

      <ul className="space-y-2">
        {skills.map((skill) => (
          <li
            key={skill.name}
            data-testid={`skill-row-${skill.name}`}
            className="flex items-start gap-3 rounded-[10px] border border-[#17231b] bg-[#0c0e0c] px-3 py-[10px]"
          >
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[13px] text-[#e6e8e6]">{skill.name}</div>
              <div className="text-[11px] text-[#6b726b]">
                {skill.description || "no description"}
              </div>
            </div>
            {mayWrite && (
              <div className="flex shrink-0 gap-1">
                {/* Which ROOT to remove from has to be asked, because the same name can exist in
                    both and only one of them is the one being looked at. */}
                {(["project", "host"] as const).map((where) => (
                  <button
                    key={where}
                    type="button"
                    data-testid={`skill-remove-${skill.name}-${where}`}
                    disabled={busy}
                    onClick={() => {
                      clearError();
                      setNote(null);
                      removeSkill(skill.name, where)
                        .then(() => setNote(`Moved ${skill.name} aside (${where})`))
                        .catch(() => undefined);
                    }}
                    className="rounded-[7px] border border-[#17231b] bg-[#0e140f] px-[8px] py-[4px] font-mono text-[10px] text-[#c9a227] hover:border-[#c9a227] disabled:opacity-50"
                  >
                    remove from {where}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      {skills.length === 0 && (
        <p data-testid="skills-empty" className="text-[12px] text-[#6b726b]">
          No skills installed on the host.
        </p>
      )}

      {!mayWrite && (
        <p data-testid="skills-read-only" className="text-[11px] text-[#6b726b]">
          Adding or removing skills is the owner’s — a skill changes what every future run can do.
        </p>
      )}

      {mayWrite && (
        <form onSubmit={submit} data-testid="skill-add-form" className="space-y-3">
          <h2 className="text-[13px] font-semibold text-[#e6e8e6]">Add a skill</h2>

          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-[0.5px] text-[#565d58]">Where</span>
            <select
              aria-label="Scope"
              data-testid="skill-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as SkillScope)}
              className="w-full rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[7px] font-mono text-[12px] text-[#cdd2cd]"
            >
              <option value="project">this repo (.claude/skills)</option>
              <option value="host">host-wide (~/.claude/skills)</option>
            </select>
            {/* The blast radius, in words, next to the control that sets it. */}
            <span data-testid="skill-scope-note" className="block text-[11px] text-[#c9a227]">
              {SCOPE_NOTE[scope]}
            </span>
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-[0.5px] text-[#565d58]">Name</span>
            <input
              aria-label="Skill name"
              data-testid="skill-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="deploy-notes"
              className="w-full rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[7px] font-mono text-[12px] text-[#e6e8e6] placeholder:text-[#5c6b5f]"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-[0.5px] text-[#565d58]">
              When it applies
            </span>
            <input
              aria-label="Skill description"
              data-testid="skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Use when preparing a release note"
              className="w-full rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[7px] font-mono text-[12px] text-[#e6e8e6] placeholder:text-[#5c6b5f]"
            />
            {/* The description is the ONLY thing in the model's index; the body is loaded on demand,
                so a vague description means the skill is never opened. */}
            <span className="block text-[11px] text-[#6b726b]">
              This is all Claude sees until it decides to load the skill — say when to use it.
            </span>
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-[0.5px] text-[#565d58]">
              Instructions
            </span>
            <textarea
              aria-label="Skill instructions"
              data-testid="skill-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder={"# Release notes\n\n1. Read the changelog…"}
              className="w-full rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[7px] font-mono text-[12px] text-[#e6e8e6] placeholder:text-[#5c6b5f]"
            />
          </label>

          <button
            type="submit"
            data-testid="skill-add"
            disabled={busy || name.trim() === ""}
            className="rounded-[9px] bg-[#3b9dff] px-[13px] py-[7px] font-mono text-[12px] font-semibold text-[#04101f] disabled:opacity-50"
          >
            {busy ? "Writing…" : "Add skill"}
          </button>
        </form>
      )}

      {error && (
        <p data-testid="skills-error" className="text-[12px] text-[#f0a8a8]">
          {error}
        </p>
      )}
      {note && (
        <p data-testid="skills-note" className="text-[12px] text-[#7cd992]">
          {note}
        </p>
      )}
    </div>
  );
};
