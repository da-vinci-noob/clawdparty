# frozen_string_literal: true

require 'rails_helper'
require 'open3'
require 'tmpdir'
require 'fileutils'

RSpec.describe(RepoBrowser) do
  subject(:browser) { described_class.new(session, worktree: worktree) }

  let(:session) { create(:session) }
  let(:worktree) { Git::WorktreeManager.new(session, repo_root: @repo) }

  def git!(dir, *args)
    out, err, st = Open3.capture3('git', '-C', dir, *args)
    raise("git #{args.join(' ')} failed: #{err}#{out}") unless st.success?
  end

  around do |example|
    Dir.mktmpdir('clawd-repo') do |dir|
      git!(dir, 'init', '-b', 'main')
      git!(dir, 'config', 'user.email', 'a@b.c')
      git!(dir, 'config', 'user.name', 'x')
      File.write(File.join(dir, 'README.md'), "seed\n")
      File.write(File.join(dir, '.gitignore'), "ignored.txt\n")
      git!(dir, 'add', '-A')
      git!(dir, 'commit', '-m', 'init')
      @repo = dir
      @wt = worktree.ensure_worktree!
      example.run
    end
  end

  def wt(path)
    File.join(@wt, path)
  end

  describe '#tree' do
    it 'lists tracked + untracked-not-ignored files, excluding ignored and .git' do
      File.write(wt('untracked.rb'), "x\n")
      File.write(wt('ignored.txt'), "secret-ish but ignored\n")

      tree = browser.tree
      expect(tree).to(include('README.md', '.gitignore', 'untracked.rb'))
      expect(tree).not_to(include('ignored.txt'))
      expect(tree.none? { |p| p.start_with?('.git/') }).to(be(true))
    end
  end

  describe '#content (happy path)' do
    it 'returns the file content via the safe pipeline' do
      expect(browser.content('README.md')).to(eq("seed\n"))
    end
  end

  describe '#content containment (traversal + symlink escape)' do
    it 'refuses a ../ traversal that escapes the worktree' do
      expect { browser.content('../../etc/passwd') }.to(raise_error(RepoBrowser::NotFound))
    end

    it 'refuses an absolute path outside the worktree' do
      expect { browser.content('/etc/passwd') }.to(raise_error(RepoBrowser::NotFound))
    end

    it 'refuses a symlink that resolves outside the worktree' do
      File.symlink('/etc/passwd', wt('escape_link'))
      expect { browser.content('escape_link') }.to(raise_error(RepoBrowser::NotFound))
    end
  end

  describe '#content denylist' do
    %w[.env .env.local server.pem private.key id_rsa app_secret.txt].each do |name|
      it "refuses denylisted #{name}" do
        File.write(wt(name), "sensitive\n")
        expect { browser.content(name) }.to(raise_error(RepoBrowser::NotFound))
      end
    end

    it 'refuses anything under .git/' do
      expect { browser.content('.git/config') }.to(raise_error(RepoBrowser::NotFound))
    end
  end

  describe '#content size + binary' do
    it 'refuses a file larger than 1MB with Oversized' do
      File.write(wt('big.txt'), 'a' * (RepoBrowser::MAX_BYTES + 1))
      expect { browser.content('big.txt') }.to(raise_error(RepoBrowser::Oversized))
    end

    it 'refuses a binary (null-byte) file with Binary' do
      File.binwrite(wt('logo.png'), "\x89PNG\x00\x01\x02")
      expect { browser.content('logo.png') }.to(raise_error(RepoBrowser::Binary))
    end
  end

  describe '#content missing' do
    it 'refuses a non-existent path with NotFound' do
      expect { browser.content('does_not_exist.rb') }.to(raise_error(RepoBrowser::NotFound))
    end
  end
end
