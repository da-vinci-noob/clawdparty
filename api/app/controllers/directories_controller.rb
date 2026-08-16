# frozen_string_literal: true

# Server directory listing that backs the web folder picker: the immediate
# subdirectories of a path, each flagged whether it is a git repo. Every path is
# realpath-contained within one of the configured BROWSE ROOTS (the shared RepoPaths
# rule — defeats `../` + symlink escape); an escaping or unresolvable path is a 404.
# Any authenticated participant may read it — there is no session to view-gate against
# (the route is not nested).
#
# Paths in this API are ABSOLUTE. They were repo-root-relative while there was exactly
# one root; with a configurable SET  a relative path has no unambiguous base.
# `session.repository_path` was already stored absolute, so this removes a conversion
# rather than adding one.
#
# The response carries `parent`, so the CLIENT never does path arithmetic. It cannot:
# "up" from a browse root is the synthetic root level (`""`), not the filesystem
# parent, and only the server knows where the roots are.
class DirectoriesController < ApplicationController
  before_action :require_user

  rescue_from RepoPaths::Escape, with: :render_not_found

  # GET /api/directories?path=<absolute>   ("" or absent = the browse roots)
  def index
    return render(json: root_level, status: :ok) if params[:path].blank?

    dir, = RepoPaths.contain_any!(BrowseRoots.all, params[:path])
    render(json: {
             path: dir,
             parent: parent_of(dir),
             is_git_repo: git_repo?(dir),
             entries: entries(dir)
           }, status: :ok)
  end

  private

  # The synthetic top level: the configured roots themselves. Listed rather than
  # auto-descending into a single root, so the shape is identical whether one root is
  # configured or five — `path: ""` never means two different things depending on an
  # env var.
  def root_level
    { path: '', parent: nil, is_git_repo: false,
      entries: BrowseRoots.all.map { |root| entry(root) } }
  end

  # `nil` at the synthetic level, `""` at a root (up leads to the root list), the
  # filesystem parent anywhere deeper.
  def parent_of(dir)
    return '' if BrowseRoots.root?(dir)

    File.dirname(dir)
  end

  # True when the directory itself is a git repo (`.git` dir for a normal repo,
  # file for a worktree). Reported for both the current dir and each child so the
  # picker can require a git repo for review sessions.
  def git_repo?(abs)
    File.exist?(File.join(abs, '.git'))
  end

  # Immediate subdirectories only (no recursion), dot-directories hidden (so
  # `.git`/`.clawdparty` don't clutter the picker), sorted by name. Children that
  # resolve outside EVERY root (a symlink escape) are excluded — the listing never
  # surfaces a path the picker couldn't navigate into.
  def entries(dir)
    roots = BrowseRoots.all
    Dir.children(dir)
       .reject { |name| name.start_with?('.') }
       .map { |name| File.join(dir, name) }
       .select { |abs| contained_dir?(roots, abs) }
       .sort
       .map { |abs| entry(abs) }
  rescue SystemCallError
    []
  end

  # A directory whose realpath stays inside some root (defeats symlink escape).
  def contained_dir?(roots, abs)
    return false unless File.directory?(abs)

    real = File.realpath(abs)
    roots.any? { |root| RepoPaths.contained?(real, root) }
  rescue SystemCallError
    false
  end

  def entry(abs)
    { name: File.basename(abs), path: abs, is_git_repo: git_repo?(abs) }
  end
end
