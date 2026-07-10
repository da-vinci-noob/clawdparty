# frozen_string_literal: true

require 'rails_helper'
require 'tmpdir'
require 'fileutils'

RSpec.describe(RepoPaths) do
  around do |example|
    Dir.mktmpdir('clawd-paths') do |dir|
      FileUtils.mkdir_p(File.join(dir, 'sub', 'dir'))
      @root = File.realpath(dir)
      example.run
    end
  end

  describe '.contain!' do
    it 'resolves a relative path against the root' do
      expect(described_class.contain!(@root, 'sub/dir')).to(eq(File.join(@root, 'sub', 'dir')))
    end

    it 'resolves an absolute-in-root path to the same place (no double-prefix)' do
      abs = File.join(@root, 'sub', 'dir')
      expect(described_class.contain!(@root, abs)).to(eq(abs))
    end

    it 'resolves a relative path and its absolute form identically' do
      rel = described_class.contain!(@root, 'sub/dir')
      abs = described_class.contain!(@root, File.join(@root, 'sub', 'dir'))
      expect(rel).to(eq(abs))
    end

    it 'resolves a blank path to the root itself' do
      expect(described_class.contain!(@root, '')).to(eq(@root))
    end

    it 'refuses a relative traversal escape' do
      expect { described_class.contain!(@root, '../../etc') }.to(raise_error(described_class::Escape))
    end

    it 'refuses an absolute path outside the root' do
      expect { described_class.contain!(@root, '/etc') }.to(raise_error(described_class::Escape))
    end

    it 'refuses an unresolvable (missing) path' do
      expect { described_class.contain!(@root, 'nope/missing') }.to(raise_error(described_class::Escape))
    end
  end
end
