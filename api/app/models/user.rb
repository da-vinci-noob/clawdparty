# frozen_string_literal: true

# == Schema Information
#
# Table name: users
# Database name: primary
#
#  id         :bigint           not null, primary key
#  name       :string           not null
#  created_at :datetime         not null
#  updated_at :datetime         not null
#
class User < ApplicationRecord
  has_many :participants, dependent: :destroy
  has_many :hosted_sessions, class_name: 'Session', foreign_key: :host_id, inverse_of: :host,
                             dependent: :nullify

  validates :name, presence: true
end
