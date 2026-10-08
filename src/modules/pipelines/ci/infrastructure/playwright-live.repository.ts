import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import { PLAYWRIGHT_LIVE_RUN_RETENTION } from '../application/playwright-live.rules';

/**
 * Persistence for live Playwright progress (workflow.playwright_live_runs and
 * workflow.playwright_live_tests; see
 * supabase/migrations/pipelines/20261008010000_playwright_live_progress.sql).
 *
 * Every write is an upsert on a natural key so a resent batch changes nothing.
 * Every read names a repository: these tables hold other customers' runs.
 */

type Timestamp = Date | string;

export interface PlaywrightLiveRunKey {
  repoFullName: string;
  branch: string;
  runId: number;
  runAttempt: number;
  commitSha: string;
}

export interface PlaywrightLiveRunRow {
  pk: string;
  branch: string;
  runId: number;
  runAttempt: number;
  commitSha: string;
  status: 'running' | 'passed' | 'failed' | 'timedout' | 'interrupted';
  total: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface PlaywrightLiveTestKey {
  testKey: string;
  project: string;
  retry: number;
}

export interface PlaywrightLiveTestStartRow extends PlaywrightLiveTestKey {
  file: string;
  title: string;
  startedAt: string;
}

export interface PlaywrightLiveTestFinishRow extends PlaywrightLiveTestKey {
  file: string;
  title: string;
  status: string;
  durationMs: number;
  error: string | null;
  finishedAt: string;
}

export interface PlaywrightLiveTestRow {
  testKey: string;
  file: string;
  title: string;
  project: string;
  retry: number;
  status: string;
  durationMs: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

function iso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: Timestamp | null): string | null {
  return value === null ? null : iso(value);
}

@Injectable()
export class PlaywrightLiveRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /** Create the run row on first contact; later calls just touch updated_at. */
  async upsertRun(key: PlaywrightLiveRunKey): Promise<string> {
    const result = await this.databaseService.query<{ id: string }>(
      `
        INSERT INTO workflow.playwright_live_runs (
          repo_full_name, branch, run_id, run_attempt, commit_sha
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (repo_full_name, run_id, run_attempt)
        DO UPDATE SET updated_at = NOW()
        RETURNING id;
      `,
      [key.repoFullName, key.branch, key.runId, key.runAttempt, key.commitSha],
    );
    return result.rows[0]!.id;
  }

  async markRunStarted(
    runPk: string,
    total: number,
    startedAt: string,
  ): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE workflow.playwright_live_runs
        SET total = $2,
            started_at = COALESCE(started_at, $3::timestamptz),
            updated_at = NOW()
        WHERE id = $1;
      `,
      [runPk, total, startedAt],
    );
  }

  async markRunFinished(
    runPk: string,
    status: string,
    summary: unknown,
    finishedAt: string,
  ): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE workflow.playwright_live_runs
        SET status = $2,
            summary = $3::jsonb,
            finished_at = $4::timestamptz,
            updated_at = NOW()
        WHERE id = $1;
      `,
      [runPk, status, JSON.stringify(summary), finishedAt],
    );
  }

  async countTests(runPk: string): Promise<number> {
    const result = await this.databaseService.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM workflow.playwright_live_tests WHERE run_pk = $1;',
      [runPk],
    );
    return result.rows[0]?.n ?? 0;
  }

  async listTestKeys(runPk: string): Promise<PlaywrightLiveTestKey[]> {
    const result = await this.databaseService.query<{
      test_key: string;
      project: string;
      retry: number;
    }>(
      'SELECT test_key, project, retry FROM workflow.playwright_live_tests WHERE run_pk = $1;',
      [runPk],
    );
    return result.rows.map((row) => ({
      testKey: row.test_key,
      project: row.project,
      retry: row.retry,
    }));
  }

  /**
   * Record starts. A start that arrives after the finish of the same test
   * (batches are not strictly ordered across resends) never reopens it: the
   * status column is left alone on conflict.
   */
  async upsertTestStarts(
    runPk: string,
    rows: PlaywrightLiveTestStartRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.databaseService.query(
      `
        INSERT INTO workflow.playwright_live_tests (
          run_pk, test_key, file, title, project, retry, status, started_at
        )
        SELECT $1::uuid, t.test_key, t.file, t.title, t.project, t.retry, 'running', t.started_at
        FROM unnest(
          $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::timestamptz[]
        ) AS t(test_key, file, title, project, retry, started_at)
        ON CONFLICT (run_pk, test_key, project, retry)
        DO UPDATE SET started_at = COALESCE(
          workflow.playwright_live_tests.started_at, EXCLUDED.started_at
        );
      `,
      [
        runPk,
        rows.map((row) => row.testKey),
        rows.map((row) => row.file),
        rows.map((row) => row.title),
        rows.map((row) => row.project),
        rows.map((row) => row.retry),
        rows.map((row) => row.startedAt),
      ],
    );
  }

  async upsertTestFinishes(
    runPk: string,
    rows: PlaywrightLiveTestFinishRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.databaseService.query(
      `
        INSERT INTO workflow.playwright_live_tests (
          run_pk, test_key, file, title, project, retry,
          status, duration_ms, error, finished_at
        )
        SELECT $1::uuid, t.test_key, t.file, t.title, t.project, t.retry,
               t.status, t.duration_ms, t.error, t.finished_at
        FROM unnest(
          $2::text[], $3::text[], $4::text[], $5::text[], $6::int[],
          $7::text[], $8::int[], $9::text[], $10::timestamptz[]
        ) AS t(test_key, file, title, project, retry, status, duration_ms, error, finished_at)
        ON CONFLICT (run_pk, test_key, project, retry)
        DO UPDATE SET
          file = EXCLUDED.file,
          title = EXCLUDED.title,
          status = EXCLUDED.status,
          duration_ms = EXCLUDED.duration_ms,
          error = EXCLUDED.error,
          finished_at = EXCLUDED.finished_at;
      `,
      [
        runPk,
        rows.map((row) => row.testKey),
        rows.map((row) => row.file),
        rows.map((row) => row.title),
        rows.map((row) => row.project),
        rows.map((row) => row.retry),
        rows.map((row) => row.status),
        rows.map((row) => row.durationMs),
        rows.map((row) => row.error),
        rows.map((row) => row.finishedAt),
      ],
    );
    await this.databaseService.query(
      'UPDATE workflow.playwright_live_runs SET updated_at = NOW() WHERE id = $1;',
      [runPk],
    );
  }

  /**
   * Retention: keep the latest `keep` runs (by run id, then attempt) per
   * repository and branch. Tests go with their run (ON DELETE CASCADE).
   */
  async pruneRuns(
    repoFullName: string,
    branch: string,
    keep = PLAYWRIGHT_LIVE_RUN_RETENTION,
  ): Promise<void> {
    await this.databaseService.query(
      `
        DELETE FROM workflow.playwright_live_runs
        WHERE repo_full_name = $1 AND branch = $2
          AND id NOT IN (
            SELECT id FROM workflow.playwright_live_runs
            WHERE repo_full_name = $1 AND branch = $2
            ORDER BY run_id DESC, run_attempt DESC
            LIMIT $3
          );
      `,
      [repoFullName, branch, keep],
    );
  }

  async findLatestRun(
    repoFullName: string,
    branch: string,
  ): Promise<PlaywrightLiveRunRow | null> {
    const result = await this.databaseService.query<{
      id: string;
      branch: string;
      run_id: string | number;
      run_attempt: number;
      commit_sha: string;
      status: PlaywrightLiveRunRow['status'];
      total: number | null;
      started_at: Timestamp | null;
      finished_at: Timestamp | null;
      updated_at: Timestamp;
    }>(
      `
        SELECT id, branch, run_id, run_attempt, commit_sha, status, total,
               started_at, finished_at, updated_at
        FROM workflow.playwright_live_runs
        WHERE repo_full_name = $1 AND branch = $2
        ORDER BY run_id DESC, run_attempt DESC
        LIMIT 1;
      `,
      [repoFullName, branch],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      pk: row.id,
      branch: row.branch,
      // bigint comes back as a string from pg; GitHub run ids fit a double.
      runId: Number(row.run_id),
      runAttempt: row.run_attempt,
      commitSha: row.commit_sha,
      status: row.status,
      total: row.total,
      startedAt: isoOrNull(row.started_at),
      finishedAt: isoOrNull(row.finished_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async listTests(
    runPk: string,
    limit: number,
  ): Promise<PlaywrightLiveTestRow[]> {
    const result = await this.databaseService.query<{
      test_key: string;
      file: string;
      title: string;
      project: string;
      retry: number;
      status: string;
      duration_ms: number | null;
      error: string | null;
      started_at: Timestamp | null;
      finished_at: Timestamp | null;
    }>(
      `
        SELECT test_key, file, title, project, retry, status, duration_ms,
               error, started_at, finished_at
        FROM workflow.playwright_live_tests
        WHERE run_pk = $1
        ORDER BY COALESCE(finished_at, started_at) ASC NULLS LAST, id ASC
        LIMIT $2;
      `,
      [runPk, limit],
    );
    return result.rows.map((row) => ({
      testKey: row.test_key,
      file: row.file,
      title: row.title,
      project: row.project,
      retry: row.retry,
      status: row.status,
      durationMs: row.duration_ms,
      error: row.error,
      startedAt: isoOrNull(row.started_at),
      finishedAt: isoOrNull(row.finished_at),
    }));
  }
}
