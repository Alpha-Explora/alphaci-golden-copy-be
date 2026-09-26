-- Put each existing frontend/backend repository pair back into one project.
--
-- Until the provisioning fix that ships alongside this migration, `ensureLink`
-- wrote one systems -> delivery_projects -> repositories chain per provisioned
-- row. A multi-repo project (`<stem>-fe` + `<stem>-be`) therefore landed in the
-- team tree as two unrelated projects. This folds each such pair into one.
--
-- Matching is deliberately strict, and by repository name (not project name,
-- because two pairs already share a duplicated project name):
--   * same team (group_id) and same GitHub owner;
--   * exactly one unarchived `<stem>-fe` and one unarchived `<stem>-be` in the
--     team, so a third same-named repository anywhere blocks the pair;
--   * each repository is the only repository row in its delivery project, and
--     each delivery project is the only one in its system, so deleting the
--     emptied chain can never cascade into anything else;
--   * none of the four chain nodes is archived.
-- Anything that does not match is left exactly as it is; the "Move repository"
-- action handles the rest by hand.
--
-- For each pair the older delivery project is kept and renamed (with its
-- system) to `<stem>`. The other repository and any channels move onto it, then
-- the emptied delivery project and system are deleted. Repository assignments
-- hang off `hierarchy.repositories` and are untouched.
--
-- Idempotent: a merged pair shares a delivery project, so it no longer passes
-- the "only repository in its delivery project" rule and re-running is a no-op.
-- Cold-replay safe: on an empty database nothing matches.

DO $$
DECLARE
  pair          RECORD;
  merged_count  INT := 0;
BEGIN
  FOR pair IN
    WITH tagged AS (
      SELECT
        r.id                  AS repository_id,
        r.group_id,
        r.delivery_project_id,
        dp.system_id,
        dp.created_at         AS delivery_created_at,
        lower(split_part(r.repo_full_name, '/', 1)) AS repo_owner,
        substring(split_part(r.repo_full_name, '/', 2) FROM '^(.+)-(?:fe|be)$') AS stem,
        substring(split_part(r.repo_full_name, '/', 2) FROM '-(fe|be)$') AS side,
        (
          dp.status <> 'archived' AND dp.archived_at IS NULL
          AND s.status <> 'archived' AND s.archived_at IS NULL
          AND (SELECT count(*) FROM hierarchy.repositories x
               WHERE x.delivery_project_id = r.delivery_project_id) = 1
          AND (SELECT count(*) FROM hierarchy.delivery_projects y
               WHERE y.system_id = dp.system_id) = 1
        ) AS is_solo
      FROM hierarchy.repositories r
      JOIN hierarchy.delivery_projects dp ON dp.id = r.delivery_project_id
      JOIN hierarchy.systems s ON s.id = dp.system_id
      WHERE r.status <> 'archived'
        AND r.archived_at IS NULL
        AND split_part(r.repo_full_name, '/', 2) ~ '^.+-(fe|be)$'
    ),
    pairs AS (
      SELECT group_id, repo_owner, lower(stem) AS stem_key
      FROM tagged
      GROUP BY group_id, repo_owner, lower(stem)
      HAVING count(*) = 2
        AND count(*) FILTER (WHERE side = 'fe') = 1
        AND count(*) FILTER (WHERE side = 'be') = 1
        AND bool_and(is_solo)
    ),
    ranked AS (
      SELECT
        t.*,
        row_number() OVER (
          PARTITION BY t.group_id, t.repo_owner, lower(t.stem)
          ORDER BY t.delivery_created_at, t.delivery_project_id
        ) AS age_rank
      FROM tagged t
      JOIN pairs p
        ON p.group_id = t.group_id
       AND p.repo_owner = t.repo_owner
       AND p.stem_key = lower(t.stem)
    )
    SELECT
      keeper.stem,
      keeper.system_id           AS keep_system_id,
      keeper.delivery_project_id AS keep_delivery_id,
      donor.repository_id        AS move_repository_id,
      donor.system_id            AS drop_system_id,
      donor.delivery_project_id  AS drop_delivery_id
    FROM ranked keeper
    JOIN ranked donor
      ON donor.group_id = keeper.group_id
     AND donor.repo_owner = keeper.repo_owner
     AND lower(donor.stem) = lower(keeper.stem)
     AND donor.age_rank = 2
    WHERE keeper.age_rank = 1
  LOOP
    UPDATE hierarchy.systems
       SET name = pair.stem, updated_at = now()
     WHERE id = pair.keep_system_id;

    UPDATE hierarchy.delivery_projects
       SET name = pair.stem, updated_at = now()
     WHERE id = pair.keep_delivery_id;

    UPDATE hierarchy.repositories
       SET delivery_project_id = pair.keep_delivery_id, updated_at = now()
     WHERE id = pair.move_repository_id;

    UPDATE hierarchy.group_channels
       SET delivery_project_id = pair.keep_delivery_id
     WHERE delivery_project_id = pair.drop_delivery_id;

    -- Both deletes re-check emptiness so a concurrent write can never be
    -- swept away by the cascade.
    DELETE FROM hierarchy.delivery_projects dp
     WHERE dp.id = pair.drop_delivery_id
       AND NOT EXISTS (SELECT 1 FROM hierarchy.repositories r
                       WHERE r.delivery_project_id = dp.id);

    DELETE FROM hierarchy.systems s
     WHERE s.id = pair.drop_system_id
       AND NOT EXISTS (SELECT 1 FROM hierarchy.delivery_projects dp
                       WHERE dp.system_id = s.id);

    RAISE NOTICE 'Merged % : kept delivery project %, moved repository %, dropped delivery project % and system %',
      pair.stem, pair.keep_delivery_id, pair.move_repository_id,
      pair.drop_delivery_id, pair.drop_system_id;

    merged_count := merged_count + 1;
  END LOOP;

  RAISE NOTICE 'Merged % split repository pair(s)', merged_count;
END $$;
