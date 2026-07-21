# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_01_01_000006) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

  # Custom types defined in this database.
  # Note that some types may not work with other database engines. Be careful if changing database.
  create_enum "ai_run_status", ["queued", "running", "awaiting_review", "approved", "rejected", "superseded", "completed_clean", "failed", "interrupted"]
  create_enum "event_actor_kind", ["claude", "user", "system"]

  create_table "ai_runs", force: :cascade do |t|
    t.string "base_sha"
    t.string "claude_session_id"
    t.datetime "created_at", null: false
    t.jsonb "diff_stats"
    t.string "model", null: false
    t.text "prompt", null: false
    t.bigint "requested_by_id"
    t.bigint "reviewed_by_id"
    t.bigint "session_id", null: false
    t.enum "status", default: "queued", null: false, enum_type: "ai_run_status"
    t.decimal "total_cost_usd", precision: 12, scale: 6
    t.datetime "updated_at", null: false
    t.jsonb "usage"
    t.index ["requested_by_id"], name: "index_ai_runs_on_requested_by_id"
    t.index ["reviewed_by_id"], name: "index_ai_runs_on_reviewed_by_id"
    t.index ["session_id"], name: "index_ai_runs_on_session_id"
    t.index ["session_id"], name: "index_ai_runs_one_active_per_session", unique: true, where: "(status = ANY (ARRAY['queued'::ai_run_status, 'running'::ai_run_status, 'awaiting_review'::ai_run_status]))"
  end

  create_table "events", force: :cascade do |t|
    t.enum "actor_kind", null: false, enum_type: "event_actor_kind"
    t.bigint "actor_participant_id"
    t.bigint "ai_run_id"
    t.datetime "created_at", null: false
    t.string "event_type", null: false
    t.jsonb "payload", default: {}, null: false
    t.bigint "seq"
    t.bigint "session_id", null: false
    t.datetime "updated_at", null: false
    t.index ["actor_participant_id"], name: "index_events_on_actor_participant_id"
    t.index ["ai_run_id", "seq"], name: "index_events_on_run_and_seq", unique: true
    t.index ["ai_run_id"], name: "index_events_on_ai_run_id"
    t.index ["session_id"], name: "index_events_on_session_id"
    t.check_constraint "(actor_kind = 'user'::event_actor_kind) = (actor_participant_id IS NOT NULL)", name: "events_user_actor_has_participant"
  end

  create_table "invites", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "expires_at"
    t.datetime "revoked_at"
    t.string "role", null: false
    t.bigint "session_id", null: false
    t.string "token_digest", null: false
    t.datetime "updated_at", null: false
    t.index ["session_id"], name: "index_invites_on_session_id"
    t.index ["token_digest"], name: "index_invites_on_token_digest", unique: true
  end

  create_table "messages", force: :cascade do |t|
    t.bigint "author_id"
    t.text "body"
    t.datetime "created_at", null: false
    t.string "kind", default: "user", null: false
    t.bigint "session_id", null: false
    t.datetime "updated_at", null: false
    t.index ["author_id"], name: "index_messages_on_author_id"
    t.index ["session_id"], name: "index_messages_on_session_id"
  end

  create_table "participants", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "last_seen_at"
    t.string "role", null: false
    t.bigint "session_id", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.index ["session_id"], name: "index_participants_on_session_id"
    t.index ["user_id"], name: "index_participants_on_user_id"
  end

  create_table "sessions", force: :cascade do |t|
    t.string "base_branch"
    t.string "branch_name"
    t.datetime "created_at", null: false
    t.bigint "host_id"
    t.datetime "last_activity_at"
    t.string "mode", default: "review", null: false
    t.text "objective"
    t.string "repository_path"
    t.string "status", default: "active", null: false
    t.string "title", null: false
    t.datetime "updated_at", null: false
    t.string "worktree_path"
    t.index ["host_id"], name: "index_sessions_on_host_id"
  end

  create_table "tasks", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.bigint "owner_id"
    t.integer "position"
    t.bigint "session_id", null: false
    t.string "status", default: "todo", null: false
    t.string "title", null: false
    t.datetime "updated_at", null: false
    t.index ["owner_id"], name: "index_tasks_on_owner_id"
    t.index ["session_id"], name: "index_tasks_on_session_id"
  end

  create_table "users", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "name", null: false
    t.datetime "updated_at", null: false
  end

  add_foreign_key "ai_runs", "participants", column: "requested_by_id"
  add_foreign_key "ai_runs", "participants", column: "reviewed_by_id"
  add_foreign_key "ai_runs", "sessions"
  add_foreign_key "events", "ai_runs"
  add_foreign_key "events", "participants", column: "actor_participant_id"
  add_foreign_key "events", "sessions"
  add_foreign_key "invites", "sessions"
  add_foreign_key "messages", "participants", column: "author_id"
  add_foreign_key "messages", "sessions"
  add_foreign_key "participants", "sessions"
  add_foreign_key "participants", "users"
  add_foreign_key "sessions", "users", column: "host_id"
  add_foreign_key "tasks", "participants", column: "owner_id"
  add_foreign_key "tasks", "sessions"
end
