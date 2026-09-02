/**
 * reconcile-deleted-repos.ts
 *
 * Scheduled sweep that hard-deletes provisioned_projects rows whose GitHub
 * repository has been confirmed gone (a clean 404 from the GitHub API) —
 * this catches the backlog of repos that were already deleted on GitHub
 * before the live repository.deleted webhook path
 * (ProjectsService.handleRepositoryDeleted) existed. Once that backlog is
 * cleared, this job is a safety net for any webhook delivery GitHub failed
 * to send (webhooks are at-most-once-ish in practice, even though GitHub
 * retries failed deliveries for a while).
 *
 * UNLIKE the compiled outbox relay (`scripts/process-outbox.cjs`) and
 * purge-archived-accounts.ts (the other two scheduled scripts in this repo),
 * this one IS a NestJS application context (via
 * NestFactory.createApplicationContext) rather than a bare `pg` script.
 * That's a deliberate exception to this repo's usual "standalone
 * script, not a NestJS app" convention: checking a repo against GitHub
 * requires GitHub App JWT signing (RS256), installation token exchange,
 * org-installation resolution, and rate-limit retry/backoff — all of that
 * already exists, is tested, and is security-sensitive inside GithubService.
 * Reimplementing it here in raw fetch/crypto calls would be a real
 * drift/bug risk (e.g. silently falling out of sync with GithubService's
 * "only a clean 404 counts as gone" safety rule). createApplicationContext
 * boots real DI-wired GithubService/ProjectsRepository/ProjectReconciliationService
 * instances WITHOUT starting the HTTP listener (no app.listen()), so this
 * still never receives inbound requests — it's not a running server, just a
 * script that reuses the app's service layer for one call and exits.
 *
 * Safety: ProjectReconciliationService.reconcileDeletedRepos() only deletes a project
 * when GitHub returns a clean 404 (repoExists() === false). Anything
 * inconclusive — 401/403 (bad/revoked org token, secondary rate limit),
 * 5xx, or a network error — is skipped, not deleted. A bad token or a
 * transient GitHub outage must never mass-delete every tracked project; see
 * the safety comment on reconcileDeletedRepos() itself for the full
 * reasoning (it mirrors syncProjects()'s existing behavior). It also skips
 * (never checks, never deletes) any tracked project whose repo doesn't
 * belong to the enforced org — this job authenticates with a single
 * org-level installation token, which cannot reliably distinguish "deleted"
 * from "not accessible to this token" for a repo outside that org (e.g. one
 * added via the "import an existing repo" flow).
 *
 * Required env vars: the full application environment (this boots the
 * whole Nest DI graph via AppModule) — see src/kernel/config/env.validation.ts
 * for the complete required set. The ones this job specifically exercises:
 *   SUPABASE_DB_URL / SUPABASE_DB_CA_CERT — direct Postgres connection
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (or GITHUB_APP / GITHUB_PRIVATE_KEY)
 *                                         — GitHub App credentials
 *   GITHUB_ENFORCED_ORG                  — defaults to 'Alpha-Explora' if unset
 *
 * Suggested Render Cron Job schedule: every 2 hours (e.g. '0 * / 2 * * *').
 * Reasoning: this is a backlog/safety-net sweep, not the primary deletion
 * path (the webhook handles new deletions in near-real-time) — there's no
 * user-facing urgency to running it more often than that, and a 2-hour
 * cadence keeps GitHub API usage (one request per tracked project per run)
 * comfortably low. Tighten to hourly if the tracked-project count is small
 * and the org's GitHub App rate limit has headroom to spare; widen to every
 * 6 hours once the initial pre-webhook backlog is confirmed cleared.
 *
 * Usage (production, after `npm run build`):
 *   node dist/scripts/reconcile-deleted-repos.js
 *
 * Usage (dev / ad hoc, no build step):
 *   npx ts-node --project tsconfig.json -r tsconfig-paths/register src/scripts/reconcile-deleted-repos.ts
 */

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { ProjectReconciliationService } from '#modules/projects/index.js';

async function run(): Promise<void> {
  const logger = new Logger('ReconcileDeletedRepos');

  const app = await NestFactory.createApplicationContext(AppModule, {
    // No inbound requests are ever served — this never calls app.listen().
    logger: ['error', 'warn', 'log'],
  });

  try {
    const reconciliationService = app.get(ProjectReconciliationService);

    logger.log('Starting scheduled repository-deletion reconciliation…');
    const result = await reconciliationService.reconcileDeletedRepos();

    logger.log(
      `Done — ${String(result.total)} tracked project(s), ${String(
        result.checked,
      )} checked, deleted ${String(result.deleted)}, skipped ${String(
        result.skipped,
      )} (inconclusive GitHub check), ${String(
        result.outOfScope,
      )} out of scope (repo outside the enforced org).`,
    );
  } finally {
    await app.close();
  }
}

run().catch((err: unknown) => {
  console.error(
    '[reconcile-deleted-repos] Fatal error:',
    err instanceof Error ? err.message : String(err),
  );
  process.exitCode = 1;
});
