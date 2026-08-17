# frozen_string_literal: true

require 'rails_helper'
require 'open3'
require 'tmpdir'
require 'fileutils'

# Three contract fields the core review loop declared and never populated.
#
# Found by running scenario S0 against the live stack: a real Bedrock run edited a file,
# reached `awaiting_review`, and was approved — and the record it left said almost nothing about
# the changeset. `changeset_ready` and `changeset_approved` both carried `payload: {}` against a
# frozen contract declaring `{files_changed, insertions, deletions}` and `{commit_sha}`, and
# `ai_runs.base_sha` was NULL even though `Runs::Start`'s own comment says it records one.
#
# base_sha is the consequential one. `Git::LaneConflicts#commit_range_args` returns nil on a blank
# one, so with the column never written, a conflict with a lane whose change is already COMMITTED
# was never reported. Measured, not assumed: the `unreviewed` kind diffs the
# working tree and needs no base, so only the approved kind was affected. Its own spec passes
# because the fixture sets `base_sha` itself — doing production's job is how the gap stayed hidden.
RSpec.describe('changeset payloads') do
  let(:session) { create(:session, repository_path: @repo) }
  let(:owner) { create(:participant, session: session, role: 'owner') }

  around do |example|
    Dir.mktmpdir('clawd-changeset') do |dir|
      @repo = File.join(dir, 'project')
      @root = File.join(dir, 'root')
      FileUtils.mkdir_p([@repo, @root])
      git!(@repo, 'init', '-b', 'main')
      git!(@repo, 'config', 'user.email', 'a@b.c')
      git!(@repo, 'config', 'user.name', 'x')
      File.write(File.join(@repo, 'hello.rb'), "def greet\n  'hi'\nend\n")
      git!(@repo, 'add', '-A')
      git!(@repo, 'commit', '-m', 'init')
      # Finalize builds its OWN WorktreeManager from the default root, so the env var is what
      # points it at this temp tree — an injected manager would not be the one under test.
      previous = ENV.fetch('REPO_ROOT', nil)
      ENV['REPO_ROOT'] = @root
      begin
        example.run
      ensure
        ENV['REPO_ROOT'] = previous
      end
    end
  end

  def git!(dir, *args)
    out, err, status = Open3.capture3('git', '-C', dir, *args)
    raise("git #{args.join(' ')} failed: #{err}#{out}") unless status.success?

    out
  end

  def manager(lane: 'main')
    Git::WorktreeManager.new(session, repo_root: @root, lane: lane)
  end

  # `Runs::Finalize` is driven by `Events::Ingest`, not by `Events::Append` — appending alone
  # advances nothing, so the transition is invoked the way ingest invokes it.
  def finish(run)
    Events::Append.call(
      session: session,
      event: { type: 'run_finished', actor: { kind: 'system' }, ai_run_id: run.id, seq: 1,
               payload: { stop_reason: 'end_turn' } }
    )
    Runs::Finalize.call(session.events.find_by!(event_type: 'run_finished'))
  end

  # A harness client that accepts and records, so Start's HTTP hop is not under test here.
  def fake_client
    Class.new do
      def start_run(payload)
        Harness::Client::Result.new(status: 202, body: { 'run_id' => payload[:run_id] })
      end
    end.new
  end

  describe 'Runs::Start' do
    it 'records the base_sha it created the worktree at' do
      worktree = manager
      result = Runs::Start.call(session: session, requested_by: owner, prompt: 'edit it',
                                model: 'claude-opus-4-8', client: fake_client, worktree: worktree)

      # Without this the diff has no recorded floor and lane-conflict detection is disabled for
      # every run in production, while its own spec supplies the value and passes.
      expect(result.ai_run.base_sha).to(eq(worktree.base_sha))
      expect(result.ai_run.base_sha).to(match(/\A[0-9a-f]{40}\z/))
    end

    it 'leaves it NULL for a chat session, which has no worktree to anchor to' do
      chat = create(:session, mode: 'chat', repository_path: @repo)
      participant = create(:participant, session: chat, role: 'owner')

      result = Runs::Start.call(session: chat, requested_by: participant, prompt: 'just talk',
                                model: 'claude-opus-4-8', client: fake_client)

      expect(result.ai_run.base_sha).to(be_nil)
    end
  end

  describe 'Runs::Finalize entering awaiting_review' do
    it 'states what the changeset actually contains' do
      run = create(:ai_run, session: session, status: 'running', requested_by: owner, lane: 'main')
      path = manager.ensure_worktree!
      run.update!(base_sha: manager.base_sha)
      File.write(File.join(path, 'hello.rb'), "def greet\n  'hello'\n  'there'\nend\n")
      File.write(File.join(path, 'added.rb'), "new\n")

      finish(run)

      ready = session.events.find_by(event_type: 'changeset_ready')
      expect(run.reload.status).to(eq('awaiting_review'))
      # The contract declares all three. An empty payload leaves the feed unable to say how big
      # the change is without a second REST call for the whole diff.
      expect(ready.payload['files_changed']).to(eq(2))
      expect(ready.payload['insertions']).to(be_positive)
      expect(ready.payload['deletions']).to(be >= 0)
    end

    it 'counts an untracked file, which is invisible to a bare `git diff HEAD`' do
      run = create(:ai_run, session: session, status: 'running', requested_by: owner, lane: 'main')
      path = manager.ensure_worktree!
      run.update!(base_sha: manager.base_sha)
      File.write(File.join(path, 'brand_new.rb'), "one\ntwo\n")

      finish(run)

      ready = session.events.find_by(event_type: 'changeset_ready')
      expect(ready.payload['files_changed']).to(eq(1))
      expect(ready.payload['insertions']).to(eq(2))
    end
  end

  describe 'Runs::Approve' do
    it 'records the sha of the commit it just made' do
      run = create(:ai_run, session: session, status: 'awaiting_review', requested_by: owner,
                            lane: 'main')
      path = manager.ensure_worktree!
      run.update!(base_sha: manager.base_sha)
      File.write(File.join(path, 'hello.rb'), "def greet\n  'approved'\nend\n")

      Runs::Approve.call(run: run, reviewed_by: owner, worktree: manager)

      approved = session.events.find_by(event_type: 'changeset_approved')
      # `commit!` already RETURNS this sha and it was being discarded. A commit outlives the
      # branch pointer, so without it the record cannot say what the approval produced.
      expect(approved.payload['commit_sha']).to(match(/\A[0-9a-f]{40}\z/))
      expect(approved.payload['commit_sha']).to(eq(git!(path, 'rev-parse', 'HEAD').strip))
      expect(approved.payload['commit_sha']).not_to(eq(run.base_sha))
    end
  end

  # The reason this stayed invisible: `lane_conflicts_spec` sets `base_sha` in its own fixture, so
  # it proved the ALGORITHM while production never fed it. This drives detection from `Runs::Start`,
  # which is the only version of the claim that can regress.
  #
  # It must be the APPROVED kind: `commit_range_args` is the one place `base_sha` is read
  # (`<base>..HEAD`), so an unrecorded base silenced conflicts against an already-committed sibling
  # lane. The `unreviewed` kind diffs the working tree and never needed a base at all.
  describe 'end to end from Runs::Start' do
    it 'reports a conflict with a lane whose change is already COMMITTED' do
      main = Runs::Start.call(session: session, requested_by: owner, prompt: 'edit hello',
                              model: 'claude-opus-4-8', client: fake_client,
                              worktree: manager(lane: 'main')).ai_run
      side = Runs::Start.call(session: session, requested_by: owner, prompt: 'also edit hello',
                              model: 'claude-opus-4-8', client: fake_client, lane: 'side',
                              worktree: manager(lane: 'side')).ai_run

      main_dir = manager(lane: 'main').worktree_path
      File.write(File.join(main_dir, 'hello.rb'), "main's version\n")
      git!(main_dir, 'add', '-A')
      git!(main_dir, '-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-m', 'main work')
      main.update!(status: 'approved')
      File.write(File.join(manager(lane: 'side').worktree_path, 'hello.rb'), "side's version\n")

      conflicts = Git::LaneConflicts.call(run: side, paths: ['hello.rb'])

      expect(conflicts.map(&:path)).to(include('hello.rb'))
      expect(conflicts.map(&:lane)).to(include('main'))
      expect(conflicts.map(&:kind)).to(include('approved'))
    end
  end
end
