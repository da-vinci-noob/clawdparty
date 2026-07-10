# frozen_string_literal: true

# The single realpath-containment rule, reused by every path that resolves a
# user-supplied path against a repo/worktree root (RepoBrowser content reads,
# session create, session update, the directory listing). `realpath` follows
# symlinks and collapses `..`, so neither `../escape` nor a symlink pointing
# outside can smuggle past. Escapes and unresolvable paths both raise Escape;
# each caller maps it to its own status (404 for reads, 422 for writes).
module RepoPaths
  class Escape < StandardError; end

  # Resolve `relative` against `root` and return the RESOLVED absolute path,
  # guaranteed to stay inside `root`. A blank `relative` resolves to the root
  # itself. Raises Escape on traversal/symlink escape or a missing/unresolvable
  # path.
  def self.contain!(root, relative)
    real_root = File.realpath(root)
    # File.expand_path uses the base dir only when the path is RELATIVE, so a
    # relative "sub/dir" resolves to "<root>/sub/dir" while an absolute
    # "<root>/sub/dir" stays as-is (no double-prefix, unlike File.join). A blank
    # path resolves to the root itself.
    candidate = File.expand_path(relative.to_s, real_root)
    resolved = File.realpath(candidate)
    raise(Escape, 'escapes root') unless contained?(resolved, real_root)

    resolved
  rescue SystemCallError
    # ENOENT (missing), ENOTDIR (a non-dir on the path), ELOOP (symlink cycle).
    raise(Escape, 'unresolvable path')
  end

  def self.contained?(resolved, root)
    resolved == root || resolved.start_with?("#{root}#{File::SEPARATOR}")
  end
end
