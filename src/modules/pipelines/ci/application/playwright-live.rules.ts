/**
 * Pure limits for live Playwright progress ingestion. No Nest, no I/O.
 */

/** Events accepted in one POST. */
export const PLAYWRIGHT_LIVE_MAX_EVENTS_PER_BATCH = 200;

/** Serialized body ceiling of one POST (the global parser allows 5 MB). */
export const PLAYWRIGHT_LIVE_MAX_BODY_BYTES = 256 * 1024;

/**
 * Distinct (test, project, retry) rows stored per run. Every test yields at
 * most one test_started and one test_finished, so this also bounds the
 * distinct events a run can store to roughly 5000 (2 x 2000 + run events);
 * resent duplicates collapse onto the same rows. Beyond it events are ignored
 * and logged.
 */
export const PLAYWRIGHT_LIVE_MAX_TESTS_PER_RUN = 2000;

/** Finished tests returned by the read, newest last. */
export const PLAYWRIGHT_LIVE_MAX_TESTS_RETURNED = 500;

/** Latest runs kept per (repository, branch); older run data is deleted. */
export const PLAYWRIGHT_LIVE_RUN_RETENTION = 10;

export const PLAYWRIGHT_LIVE_TEST_STATUSES = [
  'passed',
  'failed',
  'skipped',
  'timedOut',
  'interrupted',
] as const;

export const PLAYWRIGHT_LIVE_RUN_FINISH_STATUSES = [
  'passed',
  'failed',
  'timedout',
  'interrupted',
] as const;

export const PLAYWRIGHT_LIVE_EVENT_TYPES = [
  'run_started',
  'test_started',
  'test_finished',
  'run_finished',
] as const;
