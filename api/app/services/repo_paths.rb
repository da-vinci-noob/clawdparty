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
    candidate = File.expand_path(File.join(real_root, relative.to_s))
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
