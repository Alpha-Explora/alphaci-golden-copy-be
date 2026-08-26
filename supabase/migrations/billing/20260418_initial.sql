-- Migration: 20260418_initial
-- Purpose: Initial schema — core tables required for auth, subscriptions,
--          outbox, and workflow history.
--
-- Run in the Supabase SQL editor before first deployment.
-- Safe to re-run: all statements use CREATE TABLE IF NOT EXISTS / ON CONFLICT DO NOTHING.

-- ─── app_users ───────────────────────────────────────────────────────────────
-- One row per authenticated user. GitHub OAuth is the primary provider.

CREATE TABLE IF NOT EXISTS app_users (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  github_user_id   TEXT        UNIQUE,
  login            TEXT        NOT NULL,
  display_name     TEXT,
  email            TEXT,
  avatar_url       TEXT,
  provider         TEXT        NOT NULL DEFAULT 'github',
  is_dummy         BOOLEAN     NOT NULL DEFAULT false,
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_users_github_user_id ON app_users (github_user_id);
CREATE INDEX IF NOT EXISTS idx_app_users_login         ON app_users (login);

-- ─── subscription_plans ──────────────────────────────────────────────────────
-- Catalog of available subscription plans. Seeded at startup by SubscriptionsRepository.

CREATE TABLE IF NOT EXISTS subscription_plans (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code          TEXT        NOT NULL UNIQUE,
  name          TEXT        NOT NULL,
  amount_php    NUMERIC     NOT NULL DEFAULT 0,
  interval_unit TEXT        NOT NULL DEFAULT 'month' CHECK (interval_unit IN ('month', 'year')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── user_subscriptions ──────────────────────────────────────────────────────
-- One row per subscription event per user (append-only; latest row = current state).

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id               TEXT        NOT NULL,
  plan                  TEXT        NOT NULL,
  plan_code             TEXT        NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive', 'active', 'canceled')),
  provider              TEXT        NOT NULL DEFAULT 'supabase',
  amount_php            NUMERIC     NOT NULL DEFAULT 0,
  interval_unit         TEXT        NOT NULL DEFAULT 'month' CHECK (interval_unit IN ('month', 'year')),
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  cancel_at_period_end  BOOLEAN     NOT NULL DEFAULT false,
  canceled_at           TIMESTAMPTZ,
  metadata              JSONB       NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions (user_id);

-- ─── outbox_events ───────────────────────────────────────────────────────────
-- Transactional outbox for reliable event publishing (Kafka / downstream).
-- The process-outbox.ts script polls this table.

CREATE TABLE IF NOT EXISTS outbox_events (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  topic          TEXT        NOT NULL,
  aggregate_type TEXT        NOT NULL,
  aggregate_id   TEXT        NOT NULL,
  payload        JSONB       NOT NULL DEFAULT '{}',
  status         TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_status ON outbox_events (status, created_at);

-- ─── workflow_generations ────────────────────────────────────────────────────
-- History of CI/CD workflow files generated per user.

CREATE TABLE IF NOT EXISTS workflow_generations (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id               TEXT        NOT NULL,
  template_id           TEXT        NOT NULL,
  template_name         TEXT        NOT NULL,
  stack                 TEXT        NOT NULL,
  service_name          TEXT        NOT NULL,
  output_file_name      TEXT        NOT NULL,
  source_workflow_file  TEXT        NOT NULL DEFAULT '',
  source_properties_file TEXT       NOT NULL DEFAULT '',
  line_count            INTEGER     NOT NULL DEFAULT 0,
  yaml                  TEXT        NOT NULL DEFAULT '',
  sha256                TEXT        NOT NULL DEFAULT '',
  metadata              JSONB       NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_generations_user_id ON workflow_generations (user_id, created_at DESC);
