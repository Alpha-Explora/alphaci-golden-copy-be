-- Migration: 20260713064000_hierarchy_communication_stub
--
-- Purpose: Phase 5 communication tables (announcements, group chat, project
-- channels, repository activity) — see
-- docs/HIERARCHY_IMPLEMENTATION_PLAN.md §1.4, §3.1 file 5.
--
-- SCHEMA-ONLY, UNUSED THIS SESSION. No controller, service, or UI reads or
-- writes these tables yet (explicitly deferred per plan §0). They exist now
-- purely so that when Phase 5 is built, no destructive/structural migration
-- is required on top of a live Groups feature. No query pattern exists yet
-- to optimize for, so beyond PK/FK there are no additional indexes here —
-- add them when Phase 5 defines its actual read paths.

CREATE TABLE IF NOT EXISTS hierarchy.group_channels (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id            UUID        NOT NULL REFERENCES orgs.workspaces(id) ON DELETE CASCADE,
  channel_type        TEXT        NOT NULL
                                  CHECK (channel_type IN ('announcements', 'group_chat', 'project_channel', 'repository_activity')),
  delivery_project_id UUID        NULL REFERENCES hierarchy.delivery_projects(id) ON DELETE CASCADE,
  name                TEXT        NOT NULL,
  archived_at         TIMESTAMPTZ NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hierarchy.group_messages (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id         UUID        NOT NULL REFERENCES hierarchy.group_channels(id) ON DELETE CASCADE,
  author_user_id     UUID        NOT NULL,
  body               TEXT        NOT NULL,
  parent_message_id  UUID        NULL REFERENCES hierarchy.group_messages(id) ON DELETE SET NULL,
  pinned_at          TIMESTAMPTZ NULL,
  deleted_at         TIMESTAMPTZ NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS deny-by-default only, matching every other new table this session —
-- "no RLS policy work beyond the standard deny-by-default" per plan §3.1
-- file 5 (i.e. no permissive policies are added, but RLS itself is still
-- enabled for defense in depth).
ALTER TABLE hierarchy.group_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE hierarchy.group_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON hierarchy.group_channels FROM anon, authenticated;
REVOKE ALL ON hierarchy.group_messages FROM anon, authenticated;

COMMENT ON TABLE hierarchy.group_channels
  IS 'Phase 5 (communication) — schema-only, unused until Phase 5 ships. RLS deny-by-default.';
COMMENT ON TABLE hierarchy.group_messages
  IS 'Phase 5 (communication) — schema-only, unused until Phase 5 ships. RLS deny-by-default.';
