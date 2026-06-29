# frozen_string_literal: true

class CreateCoreTables < ActiveRecord::Migration[8.1]
  def change
    create_table(:users) do |t|
      t.string(:name, null: false)
      t.timestamps
    end

    create_table(:sessions) do |t|
      t.string(:title, null: false)
      t.text(:objective)
      t.string(:status, null: false, default: 'active') # active / archived (string-backed Rails enum)
      t.string(:repository_path)
      t.string(:worktree_path)
      t.string(:branch_name)
      t.string(:base_branch)
      t.references(:host, foreign_key: { to_table: :users })
      t.timestamps
    end

    create_table(:invites) do |t|
      t.references(:session, null: false, foreign_key: true)
      t.string(:token_digest, null: false)
      t.string(:role, null: false) # owner / editor / reviewer / viewer (string-backed Rails enum)
      t.datetime(:expires_at)
      t.datetime(:revoked_at)
      t.timestamps
      t.index(:token_digest, unique: true)
    end

    create_table(:participants) do |t|
      t.references(:session, null: false, foreign_key: true)
      t.references(:user, null: false, foreign_key: true)
      t.string(:role, null: false) # owner / editor / reviewer / viewer
      t.datetime(:last_seen_at)
      t.timestamps
    end

    create_table(:tasks) do |t|
      t.references(:session, null: false, foreign_key: true)
      t.string(:title, null: false)
      t.string(:status, null: false, default: 'todo') # TODO: / doing / review / done / blocked
      t.references(:owner, foreign_key: { to_table: :participants })
      t.integer(:position)
      t.timestamps
    end
  end
end
