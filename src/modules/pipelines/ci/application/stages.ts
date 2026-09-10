/**
 * The stages a pipeline reports, in the order they run.
 *
 * This is the ONE list. It was six: the resolver, the report service, the
 * request DTO, the translator, the repository row and the workflow builder each
 * carried a copy of `'access' | 'quality' | 'package'`, so adding a stage meant
 * finding all six. A missed one did not fail to compile — it failed at runtime,
 * as a report the API rejected or a stage the UI silently dropped.
 *
 * It lives in its own module rather than beside the resolver because both the
 * resolver and the translator need it, and the resolver already reads the
 * translator's `FriendlyMessage`. Putting the vocabulary in either one makes
 * the pair circular; putting it under both makes it a vocabulary.
 *
 * Widening this list is not enough on its own. `stage` carries a CHECK
 * constraint in Postgres, so a new value has to reach
 * `workflow.ci_run_reports` in a migration before anything writes one, or the
 * insert is rejected at the database.
 */
export const STAGE_ORDER = ['access', 'quality', 'package', 'verify'] as const;

export type StageId = (typeof STAGE_ORDER)[number];
