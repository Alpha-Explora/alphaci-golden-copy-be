/**
 * Provider-neutral contract used by generated workflow files and branch
 * protection.  The value is kept in the kernel so project application code
 * does not depend on the pipelines implementation merely to share a check
 * name.
 */
export const ENV_GUARD_CHECK_CONTEXT = 'env-guard';
