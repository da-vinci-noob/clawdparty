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
FactoryBot.define do
  factory :user do
    sequence(:name) { |n| "User #{n}" }
  end
end
