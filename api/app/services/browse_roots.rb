# frozen_string_literal: true

# The set of directories the folder picker may browse from.
#
# With the harness on the host, "the project" is no longer a single bind-mounted tree —
# a developer's repos may sit under several unrelated directories. So browsing starts
# from a CONFIGURABLE SET of roots rather than one `REPO_ROOT`, and containment is
# checked against whichever root holds the path.
#
# `REPO_ROOT` remains the default and remains the ONLY root Rails creates worktrees
# under (Git::WorktreeManager), because that path has to be identical on the host and
# in this container. Adding a browse root does not make it worktree-capable.
module BrowseRoots
  SEPARATOR = ':'

  # Colon-separated absolute paths, e.g. CLAWD_BROWSE_ROOTS=/Users/me/dev:/Users/me/work
  def self.env_value
    ENV.fetch('CLAWD_BROWSE_ROOTS', '')
  end

  # Resolved, existing, de-duplicated, non-nested roots. Never empty in practice:
  # REPO_ROOT is appended as the default.
  def self.all
    configured = env_value.split(SEPARATOR).map(&:strip).reject(&:empty?)
    candidates = configured.presence || [Git::WorktreeManager.repo_root]
    drop_nested(candidates.filter_map { |path| realpath(path) }.uniq)
  end

  # A root nested inside another is DROPPED, not kept. Two roots where one contains
  # the other would make "which root contains this path" ambiguous, and the answer
  # decides what a parent-of-a-root resolves to. The outer root already reaches
  # everything the inner one did.
  def self.drop_nested(roots)
    roots.sort_by(&:length).each_with_object([]) do |root, kept|
      kept << root unless kept.any? { |outer| RepoPaths.contained?(root, outer) }
    end
  end

  def self.realpath(path)
    File.realpath(path)
  rescue SystemCallError
    # A configured root that does not exist is skipped rather than fatal: one bad
    # entry must not make the picker unusable for the others.
    nil
  end

  # The root containing `absolute`, or nil. Used to decide what "up" means.
  def self.root_for(absolute)
    all.find { |root| RepoPaths.contained?(absolute, root) }
  end

  def self.root?(absolute)
    all.include?(absolute)
  end
end
