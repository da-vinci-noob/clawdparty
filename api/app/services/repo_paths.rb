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

  # Resolve `path` against a SET of roots, returning the resolved absolute path and
  # the root that contains it. Raises Escape when no root does.
  #
  # Each root is checked independently — a path is not permitted to borrow one root's
  # prefix to reach another, because `contained?` compares against `<root>/` and a
  # resolved path can only sit under one of a non-nested set.
  def self.contain_any!(roots, path)
    given = path.to_s
    # ABSOLUTE ONLY. With one root a relative path resolved against it; across a SET
    # there is no unambiguous base, and picking the first root that happens to contain
    # a matching relative path would silently choose between two real directories.
    raise(Escape, 'path must be absolute') unless given.start_with?(File::SEPARATOR)

    resolved = File.realpath(given)
    root = roots.find { |candidate| contained?(resolved, candidate) }
    raise(Escape, 'escapes every browse root') if root.nil?

    [resolved, root]
  rescue SystemCallError
    raise(Escape, 'unresolvable path')
  end

  # The trailing separator is load-bearing: without it "/Users/me/devtools" would read
  # as contained by "/Users/me/dev".
  def self.contained?(resolved, root)
    resolved == root || resolved.start_with?("#{root}#{File::SEPARATOR}")
  end
end
