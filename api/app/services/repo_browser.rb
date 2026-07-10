# frozen_string_literal: true

require 'open3'

# The single safe chokepoint for reading repository files (CLAUDE.md names it the
# owner of these rules). No controller reads repo files directly. The tree comes
# from `git ls-files --cached --others --exclude-standard` (tracked + untracked-
# not-ignored, never `.git` or `.gitignore`'d). Content reads run the pipeline:
# realpath containment FIRST (defeat `../` and symlink escape on the RESOLVED
# path), then the secret denylist, then a 1MB cap, then null-byte binary
# detection. Each refusal is a typed error the controller maps to a status.
class RepoBrowser
  # Refusals — the controller maps these to a status:
  #   NotFound  -> 404 (missing OR escapes the worktree OR denylisted)
  #   Oversized -> 413 (> MAX_BYTES)
  #   Binary    -> 415 (null byte detected)
  class NotFound < StandardError; end
  class Oversized < StandardError; end
  class Binary < StandardError; end

  MAX_BYTES = 1024 * 1024 # 1MB cap

  # Secret/sensitive denylist (matched on the path's basename, plus the `.git/`
  # internals). Denylisted paths are refused as NotFound — the response never
  # confirms a denied path's existence beyond "not available".
  DENYLIST_BASENAME = [
    /\A\.env/,        # .env, .env.local, .env.production, ...
    /\.pem\z/,
    /\.key\z/,
    /\Aid_rsa/,       # id_rsa, id_rsa.pub, ...
    /secret/i
  ].freeze

  def self.repo_root
    Git::WorktreeManager.repo_root
  end

  def initialize(session, worktree: nil)
    @session = session
    @worktree = worktree || Git::WorktreeManager.new(session)
  end

  # The file tree: tracked + untracked-not-ignored, excluding `.git` and ignored.
  def tree
    out = run_git!('ls-files', '--cached', '--others', '--exclude-standard')
    out.split("\n").map(&:strip).reject(&:empty?).sort
  end

  # A single file's content, after the full safety pipeline. Returns the text on
  # success; raises NotFound / Oversized / Binary otherwise.
  def content(path)
    absolute = contained_path!(path) # realpath containment (raises NotFound on escape/missing)
    raise(NotFound, 'denylisted') if denylisted?(path)
    raise(NotFound, 'not a file') unless File.file?(absolute)
    raise(Oversized, 'exceeds 1MB') if File.size(absolute) > MAX_BYTES

    bytes = File.binread(absolute)
    raise(Binary, 'binary content') if bytes.include?("\x00")

    bytes.force_encoding(Encoding::UTF_8)
  end

  private

  attr_reader :session, :worktree

  # Resolve the requested path against the worktree root via the shared
  # containment rule (RepoPaths), mapping its Escape to this browser's NotFound
  # so a traversal/symlink escape or missing file stays a 404.
  def contained_path!(path)
    RepoPaths.contain!(worktree.worktree_path, path)
  rescue RepoPaths::Escape
    raise(NotFound, 'unresolvable or escaping path')
  end

  def denylisted?(path)
    return true if path.split(File::SEPARATOR).include?('.git')

    base = File.basename(path)
    DENYLIST_BASENAME.any? { |pattern| pattern.match?(base) }
  end

  def run_git!(*args)
    stdout, stderr, status = Open3.capture3('git', '-C', worktree.worktree_path, *args)
    raise(NotFound, "git #{args.first} failed: #{stderr.strip}") unless status.success?

    stdout
  end
end
