# frozen_string_literal: true

require 'rails_helper'
require 'open3'
require 'tmpdir'
require 'fileutils'

# two lanes changing the same file is SURFACED, never silently resolved.
#
# Driven against real git worktrees rather than doubles, because the whole claim is about what git
# reports for two independent trees. With one worktree and one branch per lane, git never
# sees the two changes meet — which is exactly why something has to report the overlap: nothing
# will surface it on its own, and approving both leaves two divergent versions of the file.
RSpec.describe(Git::LaneConflicts) do
  let(:session) { create(:session, repository_path: @repo) }
  let(:participant) { create(:participant, session: session) }

  around do |example|
    Dir.mktmpdir('clawd-lanes') do |dir|
      @repo = File.join(dir, 'project')
      @root = File.join(dir, 'root')
      FileUtils.mkdir_p([@repo, @root])
      git!(@repo, 'init', '-b', 'main')
      git!(@repo, 'config', 'user.email', 'a@b.c')
      git!(@repo, 'config', 'user.name', 'x')
      File.write(File.join(@repo, 'shared.rb'), "original\n")
      File.write(File.join(@repo, 'only_main.rb'), "original\n")
      git!(@repo, 'add', '-A')
      git!(@repo, 'commit', '-m', 'init')
      example.run
    end
  end

  def git!(dir, *args)
    out, err, status = Open3.capture3('git', '-C', dir, *args)
    raise("git #{args.join(' ')} failed: #{err}#{out}") unless status.success?

    out
  end

  # A run in `lane`, with its worktree created and (optionally) a file edited in it.
  def run_in(lane, status:, edits: {}, commit: false)
    run = create(:ai_run, session: session, lane: lane, status: status, requested_by: participant)
    manager = Git::WorktreeManager.new(session, repo_root: @root, lane: lane)
    path = manager.ensure_worktree!
    run.update!(base_sha: manager.base_sha)
    edits.each { |file, body| File.write(File.join(path, file), body) }
    if commit
      git!(path, 'config', 'user.email', 'a@b.c')
      git!(path, 'config', 'user.name', 'x')
      git!(path, 'add', '-A')
      git!(path, 'commit', '-m', "#{lane} work")
    end
    run
  end

  # `LaneConflicts` builds sibling worktree paths through `WorktreeManager.new(session, lane:)`,
  # which resolves `repo_root` from the environment — pointed at the temp root for the test.
  def conflicts_for(run, paths)
    allow(Git::WorktreeManager).to(receive(:repo_root).and_return(@root))
    described_class.call(run: run, paths: paths)
  end

  describe 'a file two lanes both changed' do
    it 'is reported, naming the other lane' do
      run_in('review', status: 'awaiting_review', edits: { 'shared.rb' => "review edit\n" })
      mine = run_in('main', status: 'awaiting_review', edits: { 'shared.rb' => "main edit\n" })

      conflicts = conflicts_for(mine, ['shared.rb'])

      expect(conflicts.map(&:to_h)).to(eq([{ path: 'shared.rb', lane: 'review', kind: 'unreviewed' }]))
    end

    it 'reports it as `approved` when the other lane already committed it' do
      run_in('review', status: 'approved', edits: { 'shared.rb' => "review edit\n" }, commit: true)
      mine = run_in('main', status: 'awaiting_review', edits: { 'shared.rb' => "main edit\n" })

      # A different judgement from `unreviewed`: this lane's work is built on a version of the file
      # that no longer reflects what the session has accepted.
      expect(conflicts_for(mine, ['shared.rb']).map(&:kind)).to(eq(['approved']))
    end

    it 'names every conflicting lane when more than one touched the file' do
      run_in('review', status: 'awaiting_review', edits: { 'shared.rb' => "a\n" })
      run_in('third', status: 'awaiting_review', edits: { 'shared.rb' => "b\n" })
      mine = run_in('main', status: 'awaiting_review', edits: { 'shared.rb' => "c\n" })

      expect(conflicts_for(mine, ['shared.rb']).map(&:lane).sort).to(eq(%w[review third]))
    end
  end

  describe 'files only one lane changed' do
    it 'reports nothing' do
      run_in('review', status: 'awaiting_review', edits: { 'shared.rb' => "review edit\n" })
      mine = run_in('main', status: 'awaiting_review', edits: { 'only_main.rb' => "main edit\n" })

      # Over-reporting is its own failure: a reviewer who learns every changeset "conflicts" stops
      # reading the warning.
      expect(conflicts_for(mine, ['only_main.rb'])).to(eq([]))
    end

    it 'reports nothing for a single-lane session, which is every session by default' do
      mine = run_in('main', status: 'awaiting_review', edits: { 'shared.rb' => "main edit\n" })

      expect(conflicts_for(mine, ['shared.rb'])).to(eq([]))
    end
  end

  describe 'which sibling runs count' do
    it 'ignores a lane whose run is still RUNNING, since it has no changeset yet' do
      run_in('review', status: 'running', edits: { 'shared.rb' => "in flight\n" })
      mine = run_in('main', status: 'awaiting_review', edits: { 'shared.rb' => "main edit\n" })

      # Mid-run edits are not a changeset. Reporting them would warn about work that may never be
      # proposed, and would change as the other lane typed.
      expect(conflicts_for(mine, ['shared.rb'])).to(eq([]))
    end

    it 'ignores a lane whose changeset was REJECTED, since it no longer exists' do
      run_in('review', status: 'rejected', edits: { 'shared.rb' => "reverted\n" })
      mine = run_in('main', status: 'awaiting_review', edits: { 'shared.rb' => "main edit\n" })

      expect(conflicts_for(mine, ['shared.rb'])).to(eq([]))
    end

    it 'never reports the reviewing lane against itself' do
      mine = run_in('main', status: 'awaiting_review', edits: { 'shared.rb' => "main edit\n" })
      create(:ai_run, session: session, lane: 'main', status: 'approved', requested_by: participant)

      expect(conflicts_for(mine, ['shared.rb']).map(&:lane)).not_to(include('main'))
    end

    it 'uses only the NEWEST run per lane' do
      run_in('review', status: 'approved', edits: { 'shared.rb' => "old\n" }, commit: true)
      run_in('review', status: 'awaiting_review', edits: { 'shared.rb' => "new\n" })
      mine = run_in('main', status: 'awaiting_review', edits: { 'shared.rb' => "main\n" })

      # One row per lane: an older approved changeset in the same lane is already superseded, and
      # listing both would report the same lane twice for one file.
      expect(conflicts_for(mine, ['shared.rb']).length).to(eq(1))
    end
  end

  describe 'when a sibling lane cannot be read' do
    it 'reports nothing rather than failing the diff' do
      sibling = run_in('review', status: 'awaiting_review', edits: { 'shared.rb' => "review\n" })
      mine = run_in('main', status: 'awaiting_review', edits: { 'shared.rb' => "main edit\n" })
      FileUtils.rm_rf(Git::WorktreeManager.new(session, repo_root: @root, lane: sibling.lane).worktree_path)

      # A conflict report is additional information. A session must stay reviewable when a sibling
      # worktree has been pruned (bin/worktrees), moved, or never created.
      expect { conflicts_for(mine, ['shared.rb']) }.not_to(raise_error)
      expect(conflicts_for(mine, ['shared.rb'])).to(eq([]))
    end

    it 'reports nothing for an approved sibling with no recorded base_sha' do
      sibling = run_in('review', status: 'approved', edits: { 'shared.rb' => "x\n" }, commit: true)
      sibling.update!(base_sha: nil)
      mine = run_in('main', status: 'awaiting_review', edits: { 'shared.rb' => "main edit\n" })

      # Without a base there is no range to ask git about, and guessing one would report files that
      # lane never touched.
      expect(conflicts_for(mine, ['shared.rb'])).to(eq([]))
    end
  end

  describe 'an empty changeset' do
    it 'asks git nothing and reports nothing' do
      run_in('review', status: 'awaiting_review', edits: { 'shared.rb' => "review\n" })
      mine = run_in('main', status: 'awaiting_review')

      expect(conflicts_for(mine, [])).to(eq([]))
    end
  end
end
