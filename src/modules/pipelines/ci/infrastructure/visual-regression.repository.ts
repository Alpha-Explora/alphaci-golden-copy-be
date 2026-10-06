import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';

/**
 * Persistence for ALPHACI-stored visual baselines and per-run visual results
 * (workflow.visual_baselines / visual_run_snapshots / visual_run_images; see
 * supabase/migrations/pipelines/20261006010000_visual_testing.sql for the
 * design and the size assumptions behind keeping PNGs in bytea).
 *
 * Every query here names a repository, a branch and (where it applies) a run:
 * the tables hold other customers' screenshots, so there is deliberately no
 * method that reads by name alone.
 */

/** Latest runs kept per (repository, branch); older run data is deleted. */
export const VISUAL_RUN_RETENTION = 10;

/** pg hands timestamptz back as a Date; a driver config change would make it a string. */
type Timestamp = Date | string;

export interface VisualBaselineMetaRow {
  branch: string;
  name: string;
  sha256: string;
  approvedByLogin: string | null;
  approvedAt: string;
}

export interface VisualRunKey {
  repoFullName: string;
  branch: string;
  runId: number;
  browser: string;
}

export interface VisualSnapshotInput {
  name: string;
  status: 'passed' | 'changed' | 'new';
}

export interface VisualRunHeaderRow {
  runId: number;
  runAttempt: number;
  commitSha: string;
  browser: string;
  reportedAt: string;
}

export interface VisualRunSnapshotRow {
  name: string;
  status: 'passed' | 'changed' | 'new';
  hasActual: boolean;
  hasDiff: boolean;
  actualSha256: string | null;
}

export interface VisualImageInput extends VisualRunKey {
  commitSha: string;
  name: string;
  kind: 'actual' | 'diff';
  png: Buffer;
  sha256: string;
}

export interface VisualApprovalRepositoryInput extends VisualRunKey {
  names: string[];
  approvedByUserId: string;
  approvedByLogin: string | null;
}

function iso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

@Injectable()
export class VisualRegressionRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  // ─── Baselines ───────────────────────────────────────────────────────────

  /**
   * Baseline metadata (never the PNG) for the given branches. The caller
   * decides which branches to ask for: the branch itself, and `uat` as well
   * when the branch is `main` (main inherits uat's approved set).
   */
  async listBaselineMeta(
    repoFullName: string,
    branches: string[],
  ): Promise<VisualBaselineMetaRow[]> {
    const result = await this.databaseService.query<{
      branch: string;
      name: string;
      sha256: string;
      approved_by_login: string | null;
      approved_at: Timestamp;
    }>(
      `
        SELECT branch, name, sha256, approved_by_login, approved_at
        FROM workflow.visual_baselines
        WHERE repo_full_name = $1
          AND branch = ANY($2::text[])
        ORDER BY name ASC, branch ASC;
      `,
      [repoFullName, branches],
    );

    return result.rows.map((row) => ({
      branch: row.branch,
      name: row.name,
      sha256: row.sha256,
      approvedByLogin: row.approved_by_login,
      approvedAt: iso(row.approved_at),
    }));
  }

  async getBaselinePng(
    repoFullName: string,
    branch: string,
    name: string,
  ): Promise<Buffer | null> {
    const result = await this.databaseService.query<{ png: Buffer }>(
      `
        SELECT png
        FROM workflow.visual_baselines
        WHERE repo_full_name = $1 AND branch = $2 AND name = $3
        LIMIT 1;
      `,
      [repoFullName, branch, name],
    );
    return result.rows[0]?.png ?? null;
  }

  // ─── Run results: ingestion ──────────────────────────────────────────────

  /**
   * Store one run's snapshot statuses for a browser.
   *
   * Keyed without the attempt: a later attempt of the same run REPLACES the
   * earlier attempt's rows, and a report from an EARLIER attempt than the one
   * already stored is ignored (returns false) so a delayed retry of attempt 1
   * cannot overwrite attempt 2's answer. Re-posting the same attempt is an
   * idempotent upsert.
   */
  async replaceSnapshots(
    key: VisualRunKey,
    commitSha: string,
    runAttempt: number,
    snapshots: VisualSnapshotInput[],
  ): Promise<boolean> {
    const existing = await this.databaseService.query<{
      attempt: number | null;
    }>(
      `
        SELECT MAX(run_attempt)::int AS attempt
        FROM workflow.visual_run_snapshots
        WHERE repo_full_name = $1 AND branch = $2 AND run_id = $3 AND browser = $4;
      `,
      [key.repoFullName, key.branch, key.runId, key.browser],
    );
    const stored = existing.rows[0]?.attempt ?? null;
    if (stored !== null && stored > runAttempt) {
      return false;
    }

    if (stored !== null && stored < runAttempt) {
      await this.databaseService.query(
        `
          DELETE FROM workflow.visual_run_snapshots
          WHERE repo_full_name = $1 AND branch = $2 AND run_id = $3 AND browser = $4;
        `,
        [key.repoFullName, key.branch, key.runId, key.browser],
      );
    }

    if (snapshots.length === 0) {
      return true;
    }

    await this.databaseService.query(
      `
        INSERT INTO workflow.visual_run_snapshots (
          repo_full_name, branch, run_id, run_attempt, commit_sha, browser, name, status
        )
        SELECT $1, $2, $3, $4, $5, $6, s.name, s.status
        FROM unnest($7::text[], $8::text[]) AS s(name, status)
        ON CONFLICT (repo_full_name, branch, run_id, browser, name)
        DO UPDATE SET
          run_attempt = EXCLUDED.run_attempt,
          commit_sha  = EXCLUDED.commit_sha,
          status      = EXCLUDED.status,
          reported_at = NOW();
      `,
      [
        key.repoFullName,
        key.branch,
        key.runId,
        runAttempt,
        commitSha,
        key.browser,
        snapshots.map((snapshot) => snapshot.name),
        snapshots.map((snapshot) => snapshot.status),
      ],
    );
    return true;
  }

  /**
   * How many distinct snapshot names this run and browser already has (from
   * summary rows and image rows alike), and whether `name` is one of them.
   * Backs the "at most 60 snapshots per run and browser" limit on uploads,
   * which can arrive before the summary.
   */
  async countRunNames(
    key: VisualRunKey,
    name: string,
  ): Promise<{ total: number; present: boolean }> {
    const result = await this.databaseService.query<{
      total: number;
      present: boolean | null;
    }>(
      `
        SELECT COUNT(*)::int AS total, BOOL_OR(n.name = $5) AS present
        FROM (
          SELECT name FROM workflow.visual_run_snapshots
          WHERE repo_full_name = $1 AND branch = $2 AND run_id = $3 AND browser = $4
          UNION
          SELECT name FROM workflow.visual_run_images
          WHERE repo_full_name = $1 AND branch = $2 AND run_id = $3 AND browser = $4
        ) AS n;
      `,
      [key.repoFullName, key.branch, key.runId, key.browser, name],
    );
    const row = result.rows[0];
    return { total: row?.total ?? 0, present: row?.present === true };
  }

  async upsertImage(input: VisualImageInput): Promise<void> {
    await this.databaseService.query(
      `
        INSERT INTO workflow.visual_run_images (
          repo_full_name, branch, run_id, commit_sha, browser, name, kind,
          png, sha256, byte_size
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (repo_full_name, branch, run_id, browser, name, kind)
        DO UPDATE SET
          commit_sha  = EXCLUDED.commit_sha,
          png         = EXCLUDED.png,
          sha256      = EXCLUDED.sha256,
          byte_size   = EXCLUDED.byte_size,
          reported_at = NOW();
      `,
      [
        input.repoFullName,
        input.branch,
        input.runId,
        input.commitSha,
        input.browser,
        input.name,
        input.kind,
        input.png,
        input.sha256,
        input.png.length,
      ],
    );
  }

  /**
   * Retention: keep run data for the latest VISUAL_RUN_RETENTION runs of a
   * (repository, branch) and delete the rest, from both result tables.
   * "Latest" is by GitHub run id (monotonic), over runs seen in either table,
   * so an image that arrived for a run whose summary never came still ages out.
   * Baselines are never touched.
   */
  async pruneRuns(
    repoFullName: string,
    branch: string,
    keep = VISUAL_RUN_RETENTION,
  ): Promise<void> {
    const keepRuns = `
      WITH runs AS (
        SELECT run_id FROM workflow.visual_run_snapshots
        WHERE repo_full_name = $1 AND branch = $2
        UNION
        SELECT run_id FROM workflow.visual_run_images
        WHERE repo_full_name = $1 AND branch = $2
      ),
      keep AS (
        SELECT run_id FROM runs ORDER BY run_id DESC LIMIT $3
      )`;

    await this.databaseService.query(
      `${keepRuns}
        DELETE FROM workflow.visual_run_images
        WHERE repo_full_name = $1 AND branch = $2
          AND run_id NOT IN (SELECT run_id FROM keep);`,
      [repoFullName, branch, keep],
    );
    await this.databaseService.query(
      `${keepRuns}
        DELETE FROM workflow.visual_run_snapshots
        WHERE repo_full_name = $1 AND branch = $2
          AND run_id NOT IN (SELECT run_id FROM keep);`,
      [repoFullName, branch, keep],
    );
  }

  // ─── Run results: reads ──────────────────────────────────────────────────

  /**
   * The newest run (or the named run) that has snapshot rows for the branch,
   * with the browser to show: chromium when present, else the first by name.
   */
  async findRunHeader(
    repoFullName: string,
    branch: string,
    runId?: number,
  ): Promise<VisualRunHeaderRow | null> {
    const result = await this.databaseService.query<{
      run_id: string;
      run_attempt: number;
      commit_sha: string;
      browser: string;
      reported_at: Timestamp;
    }>(
      `
        SELECT
          run_id::text AS run_id,
          run_attempt,
          commit_sha,
          browser,
          MAX(reported_at) AS reported_at
        FROM workflow.visual_run_snapshots
        WHERE repo_full_name = $1
          AND branch = $2
          AND ($3::bigint IS NULL OR run_id = $3::bigint)
        GROUP BY run_id, run_attempt, commit_sha, browser
        ORDER BY run_id DESC, run_attempt DESC, (browser = 'chromium') DESC, browser ASC
        LIMIT 1;
      `,
      [repoFullName, branch, runId ?? null],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      runId: Number(row.run_id),
      runAttempt: row.run_attempt,
      commitSha: row.commit_sha,
      browser: row.browser,
      reportedAt: iso(row.reported_at),
    };
  }

  /** Snapshot statuses of one run and browser, with image presence (never the bytes). */
  async listRunSnapshots(key: VisualRunKey): Promise<VisualRunSnapshotRow[]> {
    const result = await this.databaseService.query<{
      name: string;
      status: 'passed' | 'changed' | 'new';
      has_actual: boolean;
      has_diff: boolean;
      actual_sha256: string | null;
    }>(
      `
        SELECT
          s.name,
          s.status,
          (a.id IS NOT NULL) AS has_actual,
          (d.id IS NOT NULL) AS has_diff,
          a.sha256 AS actual_sha256
        FROM workflow.visual_run_snapshots s
        LEFT JOIN workflow.visual_run_images a
          ON a.repo_full_name = s.repo_full_name
         AND a.branch = s.branch
         AND a.run_id = s.run_id
         AND a.browser = s.browser
         AND a.name = s.name
         AND a.kind = 'actual'
        LEFT JOIN workflow.visual_run_images d
          ON d.repo_full_name = s.repo_full_name
         AND d.branch = s.branch
         AND d.run_id = s.run_id
         AND d.browser = s.browser
         AND d.name = s.name
         AND d.kind = 'diff'
        WHERE s.repo_full_name = $1
          AND s.branch = $2
          AND s.run_id = $3
          AND s.browser = $4
        ORDER BY s.name ASC;
      `,
      [key.repoFullName, key.branch, key.runId, key.browser],
    );

    return result.rows.map((row) => ({
      name: row.name,
      status: row.status,
      hasActual: row.has_actual,
      hasDiff: row.has_diff,
      actualSha256: row.actual_sha256,
    }));
  }

  /**
   * One run image's bytes. The browser is resolved by the caller (the same
   * choice `findRunHeader` made), so a run reported by two browsers cannot
   * serve one browser's image under the other's snapshot.
   */
  async getRunImagePng(
    key: VisualRunKey,
    name: string,
    kind: 'actual' | 'diff',
  ): Promise<Buffer | null> {
    const result = await this.databaseService.query<{ png: Buffer }>(
      `
        SELECT png
        FROM workflow.visual_run_images
        WHERE repo_full_name = $1 AND branch = $2 AND run_id = $3
          AND browser = $4 AND name = $5 AND kind = $6
        LIMIT 1;
      `,
      [key.repoFullName, key.branch, key.runId, key.browser, name, kind],
    );
    return result.rows[0]?.png ?? null;
  }

  // ─── Approval ────────────────────────────────────────────────────────────

  /**
   * Copy the run's actual images for the named snapshots into the branch's
   * baseline, in ONE statement so the batch is atomic. Only CHANGED or NEW
   * snapshots that have an actual image qualify; the service has already
   * refused the batch if any name does not, so this returns exactly the
   * approved names and a shortfall means a concurrent change.
   */
  async promoteActualsToBaselines(
    input: VisualApprovalRepositoryInput,
  ): Promise<string[]> {
    const result = await this.databaseService.query<{ name: string }>(
      `
        INSERT INTO workflow.visual_baselines (
          repo_full_name, branch, name, browser, png, sha256, byte_size,
          approved_by, approved_by_login, approved_at,
          source_run_id, source_commit_sha
        )
        SELECT
          i.repo_full_name, i.branch, i.name, i.browser, i.png, i.sha256,
          i.byte_size, $5::uuid, $6, NOW(), i.run_id, i.commit_sha
        FROM workflow.visual_run_images i
        JOIN workflow.visual_run_snapshots s
          ON s.repo_full_name = i.repo_full_name
         AND s.branch = i.branch
         AND s.run_id = i.run_id
         AND s.browser = i.browser
         AND s.name = i.name
        WHERE i.repo_full_name = $1
          AND i.branch = $2
          AND i.run_id = $3
          AND i.browser = $4
          AND i.kind = 'actual'
          AND i.name = ANY($7::text[])
          AND s.status IN ('changed', 'new')
        ON CONFLICT (repo_full_name, branch, name)
        DO UPDATE SET
          browser           = EXCLUDED.browser,
          png               = EXCLUDED.png,
          sha256            = EXCLUDED.sha256,
          byte_size         = EXCLUDED.byte_size,
          approved_by       = EXCLUDED.approved_by,
          approved_by_login = EXCLUDED.approved_by_login,
          approved_at       = NOW(),
          source_run_id     = EXCLUDED.source_run_id,
          source_commit_sha = EXCLUDED.source_commit_sha
        RETURNING name;
      `,
      [
        input.repoFullName,
        input.branch,
        input.runId,
        input.browser,
        input.approvedByUserId,
        input.approvedByLogin,
        input.names,
      ],
    );
    return result.rows.map((row) => row.name);
  }
}
