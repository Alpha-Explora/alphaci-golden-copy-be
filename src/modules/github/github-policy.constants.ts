/**
 * GitHub branch-protection vocabulary owned by the GitHub integration.
 * Workflow generation consumes this stable check-run name through the public
 * GitHub boundary instead of making the provider depend on the workflows
 * feature.
 */
export const ENV_GUARD_CHECK_CONTEXT = 'env-guard';
