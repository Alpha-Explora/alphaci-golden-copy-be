/**
 * Read bridge from Pipelines' stored live Playwright progress to the Projects
 * workspace's Playwright tab.
 *
 * Pipelines owns `workflow.playwright_live_*` (CI data, fed by the generated
 * verify workflow's token-authenticated reporter); Projects owns who may look
 * at a repository and the GitHub reading that supplies the queued / starting
 * stage. The port speaks in repository names and returns facts only.
 * Authorization is the caller's job.
 */

/** Terminal states come from the reporter's run_finished event. */
export type PlaywrightLiveRunState =
  | 'running'
  | 'passed'
  | 'failed'
  | 'timedout'
  | 'interrupted';

export type PlaywrightLiveTestStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'timedOut'
  | 'interrupted';

export interface PlaywrightLiveTestIdentity {
  id: string;
  file: string;
  title: string;
  project: string;
}

export interface PlaywrightLiveRunningTest extends PlaywrightLiveTestIdentity {
  startedAt: string | null;
}

export interface PlaywrightLiveFinishedTest extends PlaywrightLiveTestIdentity {
  status: PlaywrightLiveTestStatus;
  durationMs: number | null;
  error: string | null;
}

export interface PlaywrightLiveRunFacts {
  runId: number;
  runAttempt: number;
  commitSha: string;
  branch: string;
  status: PlaywrightLiveRunState;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  total: number | null;
  /** Tests whose latest retry has finished (any status). */
  done: number;
  passed: number;
  /** failed + timedOut + interrupted. */
  failed: number;
  skipped: number;
  running: PlaywrightLiveRunningTest[];
  /** Finished tests, newest last, at most 500. */
  tests: PlaywrightLiveFinishedTest[];
}

export interface PlaywrightLivePort {
  /** The run with the highest (runId, runAttempt) for the branch, or null. */
  getLatestRun(
    repoFullName: string,
    branch: string,
  ): Promise<PlaywrightLiveRunFacts | null>;
}

export const PLAYWRIGHT_LIVE_PORT = Symbol('PLAYWRIGHT_LIVE_PORT');
