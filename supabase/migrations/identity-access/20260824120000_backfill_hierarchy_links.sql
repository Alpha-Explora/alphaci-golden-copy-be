-- Give every team-owned project its hierarchy link.
--
-- `HierarchyProjectLinkService.ensureLink` writes the
-- systems -> delivery_projects -> repositories chain that makes a project
-- assignable — `hierarchy.repository_assignments` references
-- `hierarchy.repositories`, so a project with no repository row has no
-- assignment surface at all and never appears in the group's project tree.
--
-- ensureLink bailed out for any workspace that was not `kind = 'team'`, which
-- meant every project created in a personal workspace was skipped. Those
-- workspaces are now teams (see 20260824110000_workspaces_are_teams), so their
-- projects are visible to the whole team but still unassignable. This closes
-- that gap, and also covers projects whose link failed at creation — ensureLink
-- is best-effort by design and only logs on failure.
--
-- Idempotent: it links only projects that have no repository row, so re-running
-- is a no-op. Deliberately environment-agnostic — no hardcoded ids.

DO $$
DECLARE
  project        RECORD;
  new_system_id  UUID;
  new_delivery_id UUID;
  linked_count   INT := 0;
BEGIN
  FOR project IN
    SELECT
      p.id,
      p.user_id,
      p.repo_full_name,
      -- Mirrors ensureLink: service_name, falling back to the repo name.
      COALESCE(NULLIF(btrim(p.service_name), ''), split_part(p.repo_full_name, '/', 2))
        AS display_name,
      CASE WHEN p.visibility = 'public' THEN 'public' ELSE 'private' END AS visibility,
      CASE WHEN p.status = 'provisioned' THEN 'active' ELSE 'pending' END AS repo_status,
      p.workspace_id
    FROM projects.provisioned_projects p
    JOIN orgs.workspaces w ON w.id = p.workspace_id AND w.kind = 'team'
    WHERE NOT EXISTS (
      SELECT 1 FROM hierarchy.repositories r
      WHERE r.provisioned_project_id = p.id
    )
  LOOP
    -- A project with no name and no repo to derive one from cannot be named,
    -- and every node in the chain is NOT NULL on name. Skip rather than invent.
    CONTINUE WHEN project.display_name IS NULL OR btrim(project.display_name) = '';

    INSERT INTO hierarchy.systems (group_id, name, owner_id, status)
    VALUES (project.workspace_id, project.display_name, project.user_id, 'active')
    RETURNING id INTO new_system_id;

    INSERT INTO hierarchy.delivery_projects (system_id, group_id, name, manager_id, status)
    VALUES (new_system_id, project.workspace_id, project.display_name, project.user_id, 'active')
    RETURNING id INTO new_delivery_id;

    INSERT INTO hierarchy.repositories (
      delivery_project_id, group_id, name, repo_full_name,
      visibility, created_by, status, provisioned_project_id
    )
    VALUES (
      new_delivery_id, project.workspace_id, project.display_name,
      project.repo_full_name, project.visibility, project.user_id,
      project.repo_status, project.id
    )
    ON CONFLICT (provisioned_project_id) DO NOTHING;

    linked_count := linked_count + 1;
  END LOOP;

  RAISE NOTICE 'Backfilled hierarchy links for % project(s)', linked_count;
END $$;
