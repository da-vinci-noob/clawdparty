# frozen_string_literal: true

require 'rails_helper'
require 'tmpdir'
require 'fileutils'

# the picker browses from a configurable SET of roots.
#
# The two rules worth testing are the ones that fail silently rather than loudly: a
# nested root makes "which root contains this path" ambiguous, and a shared string
# prefix makes an unrelated sibling look contained.
RSpec.describe(BrowseRoots) do
  around do |example|
    Dir.mktmpdir('clawd-roots') do |dir|
      @base = File.realpath(dir)
      example.run
    end
  end

  def mkdir(*parts)
    path = File.join(@base, *parts)
    FileUtils.mkdir_p(path)
    path
  end

  def with_roots(value)
    allow(described_class).to(receive(:env_value).and_return(value))
  end

  describe '.all' do
    it 'defaults to REPO_ROOT when nothing is configured' do
      root = mkdir('repo')
      with_roots('')
      allow(Git::WorktreeManager).to(receive(:repo_root).and_return(root))

      expect(described_class.all).to(eq([root]))
    end

    it 'parses a colon-separated list' do
      a = mkdir('a')
      b = mkdir('b')
      with_roots("#{a}:#{b}")

      expect(described_class.all).to(contain_exactly(a, b))
    end

    it 'ignores blank and whitespace-only entries' do
      a = mkdir('a')
      with_roots("#{a}:: : ")

      expect(described_class.all).to(eq([a]))
    end

    it 'resolves symlinked roots to their realpath' do
      real = mkdir('real')
      link = File.join(@base, 'link')
      File.symlink(real, link)
      with_roots(link)

      # Roots must be realpaths, or containment compares a resolved child against an
      # unresolved root and every path looks like an escape.
      expect(described_class.all).to(eq([real]))
    end

    it 'de-duplicates roots that resolve to the same directory' do
      real = mkdir('real')
      link = File.join(@base, 'link')
      File.symlink(real, link)
      with_roots("#{real}:#{link}")

      expect(described_class.all).to(eq([real]))
    end

    it 'skips a root that does not exist' do
      a = mkdir('a')
      with_roots("/definitely/not/here:#{a}")

      expect(described_class.all).to(eq([a]))
    end

    it 'DROPS a root nested inside another, keeping the outer one' do
      outer = mkdir('outer')
      inner = mkdir('outer', 'inner')
      with_roots("#{inner}:#{outer}")

      # Keeping both would make root_for ambiguous for anything under `inner`, and the
      # answer decides what "up from a root" resolves to. The outer root already
      # reaches everything the inner one did.
      expect(described_class.all).to(eq([outer]))
    end

    it 'keeps SIBLING roots that merely share a string prefix' do
      dev = mkdir('dev')
      devtools = mkdir('devtools')
      with_roots("#{dev}:#{devtools}")

      # THE prefix bug: "/…/devtools".start_with?("/…/dev") is true, so a check without
      # the trailing separator would drop devtools as "nested" in dev.
      expect(described_class.all).to(contain_exactly(dev, devtools))
    end
  end

  describe 'RepoPaths.contain_any! — absolute paths only' do
    it 'refuses a relative path rather than guessing a base' do
      a = mkdir('a')
      mkdir('a', 'proj')
      with_roots(a)

      # With ONE root a relative path resolved against it. Across a SET there is no
      # unambiguous base: if 'proj' exists under two roots, resolving it would silently
      # pick one real directory over another.
      expect { RepoPaths.contain_any!(described_class.all, 'proj') }
        .to(raise_error(RepoPaths::Escape, /absolute/))
    end

    it 'accepts an absolute path inside a root and returns the root it matched' do
      a = mkdir('a')
      proj = mkdir('a', 'proj')
      with_roots(a)

      expect(RepoPaths.contain_any!(described_class.all, proj)).to(eq([proj, a]))
    end

    it 'refuses a traversal that lands outside every root' do
      a = mkdir('a')
      mkdir('b')
      with_roots(a)

      expect { RepoPaths.contain_any!(described_class.all, File.join(a, '..', 'b')) }
        .to(raise_error(RepoPaths::Escape))
    end

    it 'refuses a symlink pointing outside every root' do
      a = mkdir('a')
      outside = mkdir('outside')
      link = File.join(a, 'link')
      File.symlink(outside, link)
      with_roots(a)

      # realpath resolves the link BEFORE containment, so the target decides.
      expect { RepoPaths.contain_any!(described_class.all, link) }
        .to(raise_error(RepoPaths::Escape))
    end
  end

  describe '.root_for / .root?' do
    it 'finds the root containing a path' do
      a = mkdir('a')
      b = mkdir('b')
      child = mkdir('b', 'child')
      with_roots("#{a}:#{b}")

      expect(described_class.root_for(child)).to(eq(b))
    end

    it 'returns nil for a path outside every root' do
      a = mkdir('a')
      with_roots(a)

      expect(described_class.root_for('/etc')).to(be_nil)
    end

    it 'does not treat a prefix-sharing sibling as contained' do
      dev = mkdir('dev')
      devtools = mkdir('devtools')
      with_roots(dev)

      expect(described_class.root_for(devtools)).to(be_nil)
    end

    it 'identifies a root itself' do
      a = mkdir('a')
      with_roots(a)

      expect(described_class.root?(a)).to(be(true))
      expect(described_class.root?(mkdir('a', 'sub'))).to(be(false))
    end
  end
end
