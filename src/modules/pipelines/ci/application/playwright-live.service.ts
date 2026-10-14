import { Injectable, Logger } from '@nestjs/common';

import type {
  PlaywrightLiveFinishedTest,
  PlaywrightLivePort,
  PlaywrightLiveRunFacts,
  PlaywrightLiveRunningTest,
  PlaywrightLiveTestStatus,
} from '#kernel/ports/playwright-live.port';
import type {
  PlaywrightProgressBodyDto,
  PlaywrightProgressEventDto,
} from '../api/dto/playwright-progress.dto';
import {
  PlaywrightLiveRepository,
  type PlaywrightLiveTestFinishRow,
  type PlaywrightLiveTestKey,
  type PlaywrightLiveTestRow,
  type PlaywrightLiveTestStartRow,
} from '../infrastructure/playwright-live.repository';
import {
  PLAYWRIGHT_LIVE_MAX_TESTS_PER_RUN,
  PLAYWRIGHT_LIVE_MAX_TESTS_RETURNED,
} from './playwright-live.rules';

const keyOf = (test: PlaywrightLiveTestKey): string =>
  `${test.testKey}\u0000${test.project}\u0000${String(test.retry)}`;

/**
 * Live Playwright progress: what the generated verify workflow's reporter
 * posts while a run is in flight, and what the studio's Playwright tab reads
 * (through PLAYWRIGHT_LIVE_PORT).
 *
 * Callers pass the CANONICAL repository name (the one stored on the project,
 * returned by token validation), never the caller's spelling of it.
 */
@Injectable()
export class PlaywrightLiveService implements PlaywrightLivePort {
  private readonly logger = new Logger(PlaywrightLiveService.name);

  constructor(private readonly repository: PlaywrightLiveRepository) {}

  // ─── Called by the pipeline (bearer-token authenticated) ─────────────────

  /**
   * Apply one batch. Idempotent: a resent batch changes nothing, because
   * every write is an upsert on (run, test, project, retry) and a start never
   * reopens a finished test. Events are applied in a fixed order (run start,
   * test starts, test finishes, run finish) so a batch that mixes them is
   * order-independent; within a type the first start / last finish of a key
   * wins.
   */
  async ingest(
    repoFullName: string,
    body: PlaywrightProgressBodyDto,
  ): Promise<{ accepted: number }> {
    const runPk = await this.repository.upsertRun({
      repoFullName,
      branch: body.branch,
      runId: body.runId,
      runAttempt: body.runAttempt,
      commitSha: body.commitSha,
    });

    let runStarted: Extract<
      PlaywrightProgressEventDto,
      { type: 'run_started' }
    > | null = null;
    let runFinished: Extract<
      PlaywrightProgressEventDto,
      { type: 'run_finished' }
    > | null = null;
    const starts = new Map<string, PlaywrightLiveTestStartRow>();
    const finishes = new Map<string, PlaywrightLiveTestFinishRow>();

    for (const event of body.events) {
      switch (event.type) {
        case 'run_started':
          runStarted = event;
          break;
        case 'run_finished':
          runFinished = event;
          break;
        case 'test_started': {
          const row: PlaywrightLiveTestStartRow = {
            testKey: event.test.id,
            project: event.test.project,
            retry: event.test.retry ?? 0,
            file: event.test.file,
            title: event.test.title,
            startedAt: event.at,
          };
          if (!starts.has(keyOf(row))) starts.set(keyOf(row), row);
          break;
        }
        case 'test_finished': {
          const row: PlaywrightLiveTestFinishRow = {
            testKey: event.test.id,
            project: event.test.project,
            retry: event.test.retry ?? 0,
            file: event.test.file,
            title: event.test.title,
            status: event.test.status,
            durationMs: event.test.durationMs,
            error: event.test.error ?? null,
            finishedAt: event.at,
          };
          finishes.set(keyOf(row), row);
          break;
        }
      }
    }

    const allowed = await this.applyTestCap(runPk, repoFullName, body.runId, [
      ...starts.keys(),
      ...finishes.keys(),
    ]);

    if (runStarted) {
      await this.repository.markRunStarted(
        runPk,
        runStarted.total,
        runStarted.at,
      );
    }
    await this.repository.upsertTestStarts(
      runPk,
      [...starts.entries()].filter(([k]) => allowed(k)).map(([, v]) => v),
    );
    await this.repository.upsertTestFinishes(
      runPk,
      [...finishes.entries()].filter(([k]) => allowed(k)).map(([, v]) => v),
    );
    if (runFinished) {
      await this.repository.markRunFinished(
        runPk,
        runFinished.status,
        runFinished.summary,
        runFinished.at,
      );
    }

    await this.repository.pruneRuns(repoFullName, body.branch);
    return { accepted: body.events.length };
  }

  /**
   * Returns a predicate saying whether a test key may be written. Only when
   * this batch could push the run past the per-run test cap do we read the
   * existing keys; then keys already stored are always allowed (so a resend of
   * a stored test still updates it) and new keys are allowed only while room
   * remains. Anything refused is logged once.
   */
  private async applyTestCap(
    runPk: string,
    repoFullName: string,
    runId: number,
    batchKeys: string[],
  ): Promise<(key: string) => boolean> {
    const distinct = [...new Set(batchKeys)];
    if (distinct.length === 0) return () => true;

    const stored = await this.repository.countTests(runPk);
    if (stored + distinct.length <= PLAYWRIGHT_LIVE_MAX_TESTS_PER_RUN) {
      return () => true;
    }

    const existing = new Set(
      (await this.repository.listTestKeys(runPk)).map(keyOf),
    );
    let room = Math.max(0, PLAYWRIGHT_LIVE_MAX_TESTS_PER_RUN - existing.size);
    const permitted = new Set<string>();
    let dropped = 0;
    for (const key of distinct) {
      if (existing.has(key)) {
        permitted.add(key);
      } else if (room > 0) {
        permitted.add(key);
        room -= 1;
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.logger.warn(
        `Ignoring ${String(dropped)} test(s) beyond the ${String(PLAYWRIGHT_LIVE_MAX_TESTS_PER_RUN)}-per-run cap for ${repoFullName} run ${String(runId)}.`,
      );
    }
    return (key) => permitted.has(key);
  }

  // ─── PlaywrightLivePort (called by Projects after its own access checks) ──

  async getLatestRun(
    repoFullName: string,
    branch: string,
  ): Promise<PlaywrightLiveRunFacts | null> {
    const run = await this.repository.findLatestRun(repoFullName, branch);
    if (!run) return null;

    const rows = await this.repository.listTests(
      run.pk,
      PLAYWRIGHT_LIVE_MAX_TESTS_PER_RUN,
    );
    const { running, finished } = this.currentStates(rows);

    const failedStatuses: readonly PlaywrightLiveTestStatus[] = [
      'failed',
      'timedOut',
      'interrupted',
    ];
    const count = (match: (status: PlaywrightLiveTestStatus) => boolean) =>
      finished.filter((test) => match(test.status)).length;

    return {
      runId: run.runId,
      runAttempt: run.runAttempt,
      commitSha: run.commitSha,
      branch: run.branch,
      status: run.status,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt,
      total: run.total,
      done: finished.length,
      passed: count((status) => status === 'passed'),
      failed: count((status) => failedStatuses.includes(status)),
      skipped: count((status) => status === 'skipped'),
      running,
      tests: finished.slice(-PLAYWRIGHT_LIVE_MAX_TESTS_RETURNED),
    };
  }

  /**
   * One state per (test, project): the row with the highest retry, because a
   * retried test is the same test and counts once. Finished tests are ordered
   * by completion time, newest last.
   */
  private currentStates(rows: PlaywrightLiveTestRow[]): {
    running: PlaywrightLiveRunningTest[];
    finished: PlaywrightLiveFinishedTest[];
  } {
    const latest = new Map<string, PlaywrightLiveTestRow>();
    for (const row of rows) {
      const key = `${row.testKey}\u0000${row.project}`;
      const seen = latest.get(key);
      if (!seen || row.retry >= seen.retry) latest.set(key, row);
    }

    const running: PlaywrightLiveRunningTest[] = [];
    const finished: Array<{ at: string; test: PlaywrightLiveFinishedTest }> =
      [];
    for (const row of latest.values()) {
      const identity = {
        id: row.testKey,
        file: row.file,
        title: row.title,
        project: row.project,
      };
      if (row.status === 'running') {
        running.push({ ...identity, startedAt: row.startedAt });
      } else {
        finished.push({
          at: row.finishedAt ?? row.startedAt ?? '',
          test: {
            ...identity,
            status: row.status as PlaywrightLiveTestStatus,
            durationMs: row.durationMs,
            error: row.error,
          },
        });
      }
    }
    finished.sort((a, b) => a.at.localeCompare(b.at));
    return { running, finished: finished.map((entry) => entry.test) };
  }
}
