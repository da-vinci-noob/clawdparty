# frozen_string_literal: true

# Server directory listing that backs the web folder picker: the immediate
# subdirectories under the mounted repo root for a (relative) path, each flagged
# whether it is a git repo. The path is realpath-contained within the repo root
# (the shared RepoPaths rule — defeats `../` + symlink escape); an escaping or
# unresolvable path is a 404. This exposes only the bind-mounted repo tree (the
# same trust boundary as the file browser), so any authenticated participant may
# read it — there is no session to view-gate against (the route is not nested).
class DirectoriesController < ApplicationController
  before_action :require_user

  rescue_from RepoPaths::Escape, with: :render_not_found

  # GET /api/directories?path=<relative>
  def index
    root = File.realpath(Git::WorktreeManager.repo_root)
    dir = RepoPaths.contain!(root, params[:path])
    render(json: { path: relative_to(root, dir), is_git_repo: git_repo?(dir), entries: entries(root, dir) },
           status: :ok)
  end

  private

  # True when the directory itself is a git repo (`.git` dir for a normal repo,
  # file for a worktree). Reported for both the current dir and each child so the
  # picker can require a git repo for review sessions.
  def git_repo?(abs)
    File.exist?(File.join(abs, '.git'))
  end

  # Immediate subdirectories only (no recursion), dot-directories hidden (so
  # `.git`/`.clawdparty` don't clutter the picker), sorted by name. Children that
  # resolve OUTSIDE the root (a symlink escape) are excluded — the listing never
  # surfaces a path the picker couldn't navigate into. `is_git_repo` is true when
  # the child contains a `.git` entry (dir for a normal repo, file for a worktree).
  def entries(root, dir)
    Dir.children(dir)
       .reject { |name| name.start_with?('.') }
       .map { |name| File.join(dir, name) }
       .select { |abs| contained_dir?(root, abs) }
       .sort
       .map { |abs| entry(root, abs) }
  end

  # A directory whose realpath stays inside the root (defeats symlink escape).
  def contained_dir?(root, abs)
    File.directory?(abs) && RepoPaths.contained?(File.realpath(abs), root)
  rescue SystemCallError
    false
  end

  def entry(root, abs)
    {
      name: File.basename(abs),
      path: relative_to(root, abs),
      is_git_repo: git_repo?(abs)
    }
  end

  # Path relative to the repo root; the root itself is the empty string.
  def relative_to(root, abs)
    return '' if abs == root

    abs.delete_prefix("#{root}#{File::SEPARATOR}")
  end
end
