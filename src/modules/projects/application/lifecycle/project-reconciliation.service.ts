import { Injectable, Logger, Optional } from '@nestjs/common';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import { GithubService } from '#modules/pipelines/index.js';
import { AuditEventsService } from '#modules/platform-ops/index.js';
import { NotificationEventPublisher } from '#kernel/events/platform-event-publisher.js';
import { ProjectsRepository } from '../../projects.repository';
import type { ReconcileDeletedReposResult } from '../../projects.service.types';

/**
 * System-wide cleanup for projects whose GitHub repository was deleted.
 *
 * This job is deliberately separate from the request-facing project service:
 * it has no user/session context, uses one organization installation token, and
 * must fail closed when GitHub cannot distinguish a 404 from lack of access.
 */
@Injectable()
export class ProjectReconciliationService {
  private readonly logger = new Logger(ProjectReconciliationService.name);

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly githubService: GithubService,
    @Optional()
    private readonly auditEventsService?: AuditEventsService,
    @Optional()
    private readonly notificationEventPublisher?: NotificationEventPublisher,
    @Optional()
    private readonly auditEventPublisher?: AuditEventPublisher,
  ) {}

  /**
   * Only a clean false from a token that can see the enforced organization is
   * treated as proof that a repository is gone. All other checks are skipped.
   */
  async reconcileDeletedRepos(): Promise<ReconcileDeletedReposResult> {
    const enforcedOrg = this.githubService.getEnforcedOrg();
    const { accessToken } =
      await this.githubService.getOrganizationProvisioningContextByLogin(
        enforcedOrg,
      );

    const allRows = await this.projectsRepository.listAllRepoFullNames();
    if (allRows.length === 0) {
      return { total: 0, checked: 0, deleted: 0, skipped: 0, outOfScope: 0 };
    }

    const normalizedOrg = enforcedOrg.toLowerCase();
    const rows = allRows.filter(
      (row) =>
        row.repo_full_name.split('/')[0]?.toLowerCase() === normalizedOrg,
    );
    const outOfScope = allRows.length - rows.length;
    if (outOfScope > 0) {
      this.logger.warn(
        `Reconcile: skipping ${String(outOfScope)} project(s) whose repo is outside the ${enforcedOrg} org — the org installation token cannot reliably verify them.`,
      );
    }

    const confirmedGoneRepoFullNames: string[] = [];
    let skipped = 0;
    const concurrency = 10;

    for (let i = 0; i < rows.length; i += concurrency) {
      const batch = rows.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (row) => {
          try {
            const exists = await this.githubService.repoExists(
              accessToken,
              row.repo_full_name,
            );
            if (!exists) confirmedGoneRepoFullNames.push(row.repo_full_name);
          } catch (error) {
            skipped += 1;
            this.logger.warn(
              `Reconcile: GitHub check failed for ${row.repo_full_name}: ${String(error)}`,
            );
          }
        }),
      );
    }

    const deletedByOwner = new Map<
      string,
      Array<{ id: string; user_id: string }>
    >();
    for (const repoFullName of confirmedGoneRepoFullNames) {
      const deletedRows =
        await this.projectsRepository.deleteByRepoFullName(repoFullName);
      if (deletedRows.length > 0) {
        deletedByOwner.set(repoFullName, deletedRows);
      }
    }

    const totalDeleted = [...deletedByOwner.values()].reduce(
      (sum, rowsForRepo) => sum + rowsForRepo.length,
      0,
    );
    this.logger.log(
      `Reconcile: checked ${rows.length} project(s) (${String(outOfScope)} out of scope), deleted ${totalDeleted}, skipped ${skipped} (inconclusive)`,
    );

    await Promise.all(
      [...deletedByOwner.entries()].flatMap(([repoFullName, deletedRows]) =>
        deletedRows.map((row) =>
          this.recordProductEvent({
            userId: row.user_id,
            projectId: null,
            eventCode: 'project_deleted_reconciliation',
            title: 'Repository deleted on GitHub',
            body: `The GitHub repository ${repoFullName} was found deleted during scheduled reconciliation, so this project has been deleted.`,
            metadata: {
              repoFullName,
              source: 'reconciliation',
              deletedProjectId: row.id,
            },
          }),
        ),
      ),
    );

    return {
      total: allRows.length,
      checked: rows.length,
      deleted: totalDeleted,
      skipped,
      outOfScope,
    };
  }

  private async recordProductEvent(input: {
    userId: string;
    projectId: string | null;
    eventCode: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await Promise.all([
      this.auditEventPublisher?.recordProjectEvent({
        actorUserId: input.userId,
        projectId: input.projectId,
        eventCode: input.eventCode,
        message: input.body,
        metadata: input.metadata,
      }) ??
        this.auditEventsService?.recordProjectEvent({
          actorUserId: input.userId,
          projectId: input.projectId,
          eventCode: input.eventCode,
          message: input.body,
          metadata: input.metadata,
        }),
      this.notificationEventPublisher?.record({
        userId: input.userId,
        projectId: input.projectId,
        eventCode: input.eventCode,
        title: input.title,
        body: input.body,
      }),
    ]).then(() => undefined);
  }
}
