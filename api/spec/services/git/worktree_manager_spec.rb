# frozen_string_literal: true

require 'rails_helper'
require 'open3'
require 'tmpdir'
require 'fileutils'

RSpec.describe(Git::WorktreeManager) do
  subject(:manager) { described_class.new(session, repo_root: @repo) }

  let(:session) { create(:session) }

  around do |example|
    Dir.mktmpdir('clawd-repo') do |dir|
      # A throwaway git repo with one commit, standing in for the bind-mounted /repo.
      def git!(dir, *args)
        out, err, st = Open3.capture3('git', '-C', dir, *args)
        raise("git #{args.join(' ')} failed: #{err}#{out}") unless st.success?
      end
      git!(dir, 'init', '-b', 'main')
      git!(dir, 'config', 'user.email', 'a@b.c')
      git!(dir, 'config', 'user.name', 'x')
      File.write(File.join(dir, 'README.md'), "seed\n")
      git!(dir, 'add', '-A')
      git!(dir, 'commit', '-m', 'init')
      @repo = dir
      example.run
    end
  end

  describe '.repo_root (the in-container path is always /repo, per the frozen convention)' do
    it 'does NOT read the host-side TARGET_REPO_PATH bind-mount source' do
      allow(ENV).to(receive(:fetch).and_call_original)
      # TARGET_REPO_PATH is the HOST mount source for /repo; reading it as the
      # in-container repo root points at a host path that does not exist in the
      # container (the picker/worktrees then 500). repo_root must stay /repo.
      allow(ENV).to(receive(:fetch).with('TARGET_REPO_PATH', anything).and_return('/Users/someone/Developer'))
      expect(described_class.repo_root).to(eq('/repo'))
    end
  end

  it 'creates the worktree at the frozen path + branch' do
    path = manager.ensure_worktree!
    expect(path).to(eq(File.join(@repo, '.clawdparty', 'worktrees', "session-#{session.id}")))
    expect(File.exist?(File.join(path, '.git'))).to(be(true))
    expect(File.read(File.join(path, 'README.md'))).to(eq("seed\n"))
  end

  it 'is idempotent (reuse on second call)' do
    first = manager.ensure_worktree!
    expect { manager.ensure_worktree! }.not_to(raise_error)
    expect(manager.ensure_worktree!).to(eq(first))
  end

  it 'records base_sha matching the repo HEAD' do
    manager.ensure_worktree!
    head = `git -C #{@repo} rev-parse HEAD`.strip
    expect(manager.base_sha).to(eq(head))
  end

  it 'detects a dirty worktree and reset_hard! restores it clean' do
    path = manager.ensure_worktree!
    expect(manager.dirty?).to(be(false))
    File.write(File.join(path, 'new_file.txt'), "claude wrote this\n")
    expect(manager.dirty?).to(be(true))
    manager.reset_hard!
    expect(manager.dirty?).to(be(false))
    expect(File.exist?(File.join(path, 'new_file.txt'))).to(be(false))
  end

  it 'commit! commits the dirty worktree, returns a clean tree, and preserves the change' do
    path = manager.ensure_worktree!
    File.write(File.join(path, 'approved.rb'), "kept = true\n")
    expect(manager.dirty?).to(be(true))

    sha = manager.commit!('approve changeset')
    expect(manager.dirty?).to(be(false))
    expect(sha).to(match(/\A[0-9a-f]{7,40}\z/))
    show, _e, _s = Open3.capture3('git', '-C', path, 'show', '--stat', 'HEAD')
    expect(show).to(include('approved.rb'))
  end

  describe 'commit attribution' do
    it 'attributes the commit to the approving participant' do
      participant = create(:participant, session: session, role: 'reviewer')
      path = manager.ensure_worktree!
      File.write(File.join(path, 'approved.rb'), "kept = true\n")

      manager.commit!('approve changeset', author: participant)

      author, = Open3.capture3('git', '-C', path, 'log', '-1', '--format=%an|%ae|%cn|%ce')
      name, email, committer_name, committer_email = author.strip.split('|')
      expect(name).to(eq(participant.user.name))
      # Author AND committer: a reader should not need git's author/committer
      # distinction to answer "who approved this".
      expect(committer_name).to(eq(participant.user.name))
      expect(email).to(eq("participant-#{participant.id}@clawdparty.local"))
      expect(committer_email).to(eq(email))
    end

    it 'derives the address from the participant ID, not the name' do
      # Names are neither unique nor guaranteed valid in an address; the id maps the
      # commit back to exactly one participant row.
      user = create(:user, name: 'Ada Lovelace <not an email>')
      participant = create(:participant, session: session, user: user, role: 'reviewer')
      path = manager.ensure_worktree!
      File.write(File.join(path, 'a.rb'), "1\n")

      manager.commit!('approve', author: participant)

      email, = Open3.capture3('git', '-C', path, 'log', '-1', '--format=%ae')
      expect(email.strip).to(eq("participant-#{participant.id}@clawdparty.local"))
    end

    it 'falls back to the generic identity rather than failing when the approver is unknown' do
      path = manager.ensure_worktree!
      File.write(File.join(path, 'a.rb'), "1\n")

      # Failing here would strand an APPROVED changeset in a dirty worktree, blocking
      # the next run — worse than an unattributed commit.
      expect { manager.commit!('approve', author: nil) }.not_to(raise_error)
      name, = Open3.capture3('git', '-C', path, 'log', '-1', '--format=%an')
      expect(name.strip).to(eq('clawdparty'))
    end

    it 'commits even when the repo has commit signing enabled' do
      # Found by accident: a `git commit` run from a harness bash command failed with
      # "1Password: failed to fill whole buffer" because the host had
      # commit.gpgsign=true. If that setting reaches the approve path, approve dies on a
      # credential the container does not have and STRANDS an approved changeset in a
      # dirty worktree, blocking the next run. Same reasoning as --no-verify: this is
      # clawdparty's internal bookkeeping commit on an isolated session branch.
      path = manager.ensure_worktree!
      Open3.capture3('git', '-C', path, 'config', 'commit.gpgsign', 'true')
      Open3.capture3('git', '-C', path, 'config', 'user.signingkey', 'DOES-NOT-EXIST')
      Open3.capture3('git', '-C', path, 'config', 'gpg.format', 'ssh')
      File.write(File.join(path, 'a.rb'), "1\n")

      expect { manager.commit!('approve', author: nil) }.not_to(raise_error)
      expect(manager.dirty?).to(be(false))
    end

    it 'does not read the host git config for identity' do
      # Passed with `-c` so a host with no user.name configured still commits. Without
      # it, approve fails with "Please tell me who you are" on a fresh machine.
      path = manager.ensure_worktree!
      File.write(File.join(path, 'a.rb'), "1\n")
      Open3.capture3('git', '-C', path, 'config', '--unset', 'user.name')
      Open3.capture3('git', '-C', path, 'config', '--unset', 'user.email')

      expect { manager.commit!('approve', author: nil) }.not_to(raise_error)
    end
  end

  it 'commit! is a no-op on a clean worktree (returns HEAD)' do
    manager.ensure_worktree!
    expect { manager.commit!('nothing') }.not_to(raise_error)
    expect(manager.dirty?).to(be(false))
  end

  it 'commit! bypasses repo git hooks so a failing pre-commit does not block approval' do
    hooks = File.join(@repo, '.git', 'hooks')
    FileUtils.mkdir_p(hooks)
    File.write(File.join(hooks, 'pre-commit'), "#!/bin/sh\necho 'pre-commit: not found' >&2\nexit 1\n")
    FileUtils.chmod(0o755, File.join(hooks, 'pre-commit'))

    path = manager.ensure_worktree!
    File.write(File.join(path, 'x.rb'), "1\n")
    expect { manager.commit!('approve') }.not_to(raise_error)
    expect(manager.dirty?).to(be(false))
  end

  describe 'per-repo worktree (roots at the session repository_path)' do
    # Mirror production: a NON-git parent mount holding git subdir repos. The
    # worktree must be created FROM the selected repo, with its working files
    # centralized under the (non-git) mount root.
    around do |example|
      Dir.mktmpdir('clawd-mount') do |mount|
        proj = File.join(mount, 'proj')
        FileUtils.mkdir_p(proj)
        git!(proj, 'init', '-b', 'main')
        git!(proj, 'config', 'user.email', 'a@b.c')
        git!(proj, 'config', 'user.name', 'x')
        File.write(File.join(proj, 'README.md'), "proj-seed\n")
        git!(proj, 'add', '-A')
        git!(proj, 'commit', '-m', 'init')
        @mount = mount
        @proj = proj
        example.run
      end
    end

    it 'creates the worktree from the selected repo, centralized under the mount root' do
      session.update!(repository_path: @proj)
      mgr = described_class.new(session, repo_root: @mount)
      path = mgr.ensure_worktree!

      expect(path).to(eq(File.join(@mount, '.clawdparty', 'worktrees', "session-#{session.id}")))
      expect(File.exist?(File.join(path, '.git'))).to(be(true))
      # Content comes from the SELECTED repo (proj), not the non-git mount root.
      expect(File.read(File.join(path, 'README.md'))).to(eq("proj-seed\n"))
    end

    it 'falls back to the mount root when repository_path is blank' do
      # Blank repository_path + non-git mount → the git base is the mount root,
      # which is not a repo here, so it raises (matches single-repo-mount reality).
      mgr = described_class.new(session, repo_root: @mount)
      expect { mgr.ensure_worktree! }.to(raise_error(described_class::GitError))
    end

    it 'raises GitError when the selected repository_path is not a git repo' do
      plain = File.join(@mount, 'plain')
      FileUtils.mkdir_p(plain)
      session.update!(repository_path: plain)
      mgr = described_class.new(session, repo_root: @mount)
      expect { mgr.ensure_worktree! }.to(raise_error(described_class::GitError))
    end
  end

  # Nothing removed a worktree when a session ended, so the mount root accumulated
  # checkouts indistinguishable from live ones. A live example prompted this: an orphan dated
  # 2026-07-22 for a session that no longer existed, holding real edits to two files.
  describe '#remove_worktree!' do
    it 'removes a clean worktree and its git metadata' do
      path = manager.ensure_worktree!

      expect(manager.remove_worktree!).to(eq(:removed))
      expect(Dir.exist?(path)).to(be(false))
      # `git worktree remove` deregisters it too; a leftover registration makes `git worktree
      # list` report a path that is gone.
      out, = Open3.capture3('git', '-C', @repo, 'worktree', 'list')
      expect(out).not_to(include(path))
    end

    it 'KEEPS a dirty worktree rather than destroying unreviewed work' do
      path = manager.ensure_worktree!
      File.write(File.join(path, 'README.md'), "edited but never reviewed\n")

      # An unreviewed changeset lives ONLY here. This is the whole reason removal is not
      # unconditional — and it is not hypothetical: the orphan that prompted this was dirty.
      expect(manager.remove_worktree!).to(eq(:kept_dirty))
      expect(Dir.exist?(path)).to(be(true))
      expect(File.read(File.join(path, 'README.md'))).to(include('never reviewed'))
    end

    it 'removes a dirty worktree when force is asked for explicitly' do
      path = manager.ensure_worktree!
      File.write(File.join(path, 'README.md'), "edited\n")

      expect(manager.remove_worktree!(force: true)).to(eq(:removed))
      expect(Dir.exist?(path)).to(be(false))
    end

    it 'reports :absent when there is nothing to remove' do
      # Archiving a session that never ran must not look like a failure.
      expect(manager.remove_worktree!).to(eq(:absent))
    end

    it 'is idempotent — removing twice is :absent, not an error' do
      manager.ensure_worktree!
      manager.remove_worktree!

      expect(manager.remove_worktree!).to(eq(:absent))
    end

    it 'leaves the session BRANCH behind' do
      manager.ensure_worktree!
      manager.remove_worktree!

      # The branch is the only record of an approved changeset. `git worktree remove` does not
      # touch it, and nothing here should either.
      out, = Open3.capture3('git', '-C', @repo, 'branch', '--list', manager.branch_name)
      expect(out).to(include(manager.branch_name))
    end

    it 'reports :failed rather than raising when git refuses' do
      path = manager.ensure_worktree!
      # A REAL failure rather than a stub on the object under test: delete the repo-side
      # registration and git no longer recognises the directory as a worktree, so `worktree remove`
      # refuses. This is also the shape a genuine orphan takes once its originating repo has moved.
      FileUtils.rm_rf(File.join(@repo, '.git', 'worktrees', File.basename(path)))

      # A session must be archivable whether or not its worktree is tidy.
      expect(manager.remove_worktree!(force: true)).to(eq(:failed))
    end
  end
end
