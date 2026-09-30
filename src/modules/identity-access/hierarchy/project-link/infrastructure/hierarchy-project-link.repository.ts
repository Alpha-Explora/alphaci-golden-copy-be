import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import type { ProjectFolderLink } from '#kernel/ports/project-link.port';

export interface LinkProjectInput {
  projectId: string;
  workspaceId: string;
  /** Display name for the hierarchy.repositories row. */
  name: string;
  /** Name for a newly auto-created system/delivery-project chain; falls back to `name`. */
  chainName?: string;
  repoFullName: string;
  visibility: 'private' | 'public';
  createdBy: string;
  /** provisioned_projects.status — maps to the repository row's status. */
  projectStatus: string;
  /** Link into this existing delivery project instead of creating a new chain. */
  deliveryProjectId?: string;
}

export interface LinkResult {
  repositoryId: string;
  deliveryProjectId: string;
}

/**
 * Writes the systems -> delivery_projects -> repositories chain that makes a
 * form-created GROUP project assignable.
 *
 * Deliberately raw SQL in one transaction rather than composing
 * SystemsService/DeliveryProjectsService/RepositoriesService: those perform
 * per-call authorization assertions (assertCanCreateInGroup and friends), and
 * this runs AFTER the caller has already been authorized to create the
 * project. Re-asserting there would be both redundant and wrong — the
 * assertions are written for a user action, not a system-initiated link.
 */
@Injectable()
export class HierarchyProjectLinkRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /** True when the workspace is a Group (team), not a personal workspace. */
  async isTeamWorkspace(workspaceId: string): Promise<boolean> {
    const result = await this.databaseService.query<{ exists: boolean }>(
      `SELECT TRUE AS exists FROM orgs.workspaces WHERE id = $1 AND kind = 'team' LIMIT 1;`,
      [workspaceId],
    );
    return result.rows.length > 0;
  }

  /** Existing hierarchy repository id for this project, if already linked. */
  async findLinkedRepositoryId(projectId: string): Promise<string | null> {
    const result = await this.databaseService.query<{ id: string }>(
      `SELECT id FROM hierarchy.repositories WHERE provisioned_project_id = $1 LIMIT 1;`,
      [projectId],
    );
    return result.rows[0]?.id ?? null;
  }

  /**
   * The delivery project a project is filed under, with every non-archived
   * repository row of it (the project's own row included while it is active).
   * Null when the project has no hierarchy repository row.
   */
  async findProjectFolder(
    projectId: string,
  ): Promise<ProjectFolderLink | null> {
    const result = await this.databaseService.query<{
      delivery_project_id: string;
      group_id: string;
      delivery_project_name: string;
      provisioned_project_id: string | null;
      repository_name: string | null;
      repo_full_name: string | null;
    }>(
      `
        SELECT
          dp.id    AS delivery_project_id,
          dp.group_id,
          dp.name  AS delivery_project_name,
          r.provisioned_project_id,
          r.name   AS repository_name,
          r.repo_full_name
        FROM hierarchy.repositories self
        JOIN hierarchy.delivery_projects dp ON dp.id = self.delivery_project_id
        LEFT JOIN hierarchy.repositories r
          ON r.delivery_project_id = dp.id
         AND r.status <> 'archived'
        WHERE self.provisioned_project_id = $1
        ORDER BY r.created_at, r.id;
      `,
      [projectId],
    );
    const first = result.rows[0];
    if (!first) return null;
    return {
      deliveryProjectId: first.delivery_project_id,
      groupId: first.group_id,
      name: first.delivery_project_name,
      repositories: result.rows
        .filter((row) => row.repository_name || row.repo_full_name)
        .map((row) => ({
          projectId: row.provisioned_project_id,
          name: row.repository_name ?? row.repo_full_name ?? '',
          repoFullName: row.repo_full_name,
        })),
    };
  }

  /**
   * Same idempotency lookup as `findLinkedRepositoryId`, but also returns the
   * delivery project the repository already lives under — needed so a
   * retried `ensureLink` call on an already-linked pair member can still
   * report the shared chain's id to the caller.
   */
  async findLinkedRepositoryAndDeliveryProject(
    projectId: string,
  ): Promise<LinkResult | null> {
    const result = await this.databaseService.query<{
      id: string;
      delivery_project_id: string;
    }>(
      `SELECT id, delivery_project_id FROM hierarchy.repositories WHERE provisioned_project_id = $1 LIMIT 1;`,
      [projectId],
    );
    const row = result.rows[0];
    return row
      ? { repositoryId: row.id, deliveryProjectId: row.delivery_project_id }
      : null;
  }

  /**
   * Links `projectId` into the hierarchy: either a brand new system ->
   * delivery project -> repository chain, or — when `deliveryProjectId` is
   * given — just a new repository row under that existing delivery project
   * (the multi-repo/microservices pair-linking case).
   */
  async link(input: LinkProjectInput): Promise<LinkResult | null> {
    if (input.deliveryProjectId) {
      return this.linkRepositoryOnly(input.deliveryProjectId, input);
    }
    return this.linkNewChain(input);
  }

  /**
   * Inserts ONLY the hierarchy.repositories row under an existing delivery
   * project. Re-validates that the delivery project is active and belongs to
   * the same workspace/group as the project being linked — the up-front
   * user-facing gate (`assertDeliveryProjectAvailableForCreate`) already
   * checked this for an explicit, user-supplied id, but this call is also
   * reached for the SECOND row of an auto-created pair (never user-checked
   * directly), and this method's caller (`ensureLink`) is best-effort by
   * contract — so the check has to live here too, not just upstream.
   *
   * No transaction: there is nothing else to roll back if the insert loses
   * the ON CONFLICT race (unlike `linkNewChain`, this never creates a system
   * or delivery project of its own).
   */
  private async linkRepositoryOnly(
    deliveryProjectId: string,
    input: LinkProjectInput,
  ): Promise<LinkResult | null> {
    const deliveryProject = await this.databaseService.query<{
      id: string;
      group_id: string;
      status: string;
    }>(
      `SELECT id, group_id, status FROM hierarchy.delivery_projects WHERE id = $1 LIMIT 1;`,
      [deliveryProjectId],
    );
    const row = deliveryProject.rows[0];
    if (!row || row.status !== 'active' || row.group_id !== input.workspaceId) {
      throw new Error(
        `Delivery project ${deliveryProjectId} is not an active delivery project in workspace ${input.workspaceId}`,
      );
    }

    const repository = await this.databaseService.query<{ id: string }>(
      `
        INSERT INTO hierarchy.repositories (
          delivery_project_id, group_id, name, repo_full_name,
          visibility, created_by, status, provisioned_project_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (provisioned_project_id) DO NOTHING
        RETURNING id;
      `,
      [
        deliveryProjectId,
        input.workspaceId,
        input.name,
        input.repoFullName,
        input.visibility,
        input.createdBy,
        input.projectStatus === 'provisioned' ? 'active' : 'pending',
        input.projectId,
      ],
    );

    const repositoryId = repository.rows[0]?.id;
    if (!repositoryId) {
      // Another writer linked this project first — nothing of ours to roll
      // back, since this path never creates a system/delivery project.
      return null;
    }

    return { repositoryId, deliveryProjectId };
  }

  /**
   * Creates system -> delivery project -> repository for `projectId` and
   * returns the repository id alongside the new delivery project id (so a
   * pair's second row can link into the SAME chain via `deliveryProjectId`).
   *
   * The whole chain is one transaction: a half-built tree (a system with no
   * repository) would show up in the group UI as an empty phantom project.
   * ON CONFLICT DO NOTHING on the final insert makes a concurrent double-link
   * lose harmlessly rather than violating the UNIQUE constraint — the second
   * caller re-reads the winner's row.
   */
  private async linkNewChain(
    input: LinkProjectInput,
  ): Promise<LinkResult | null> {
    const chainName = input.chainName ?? input.name;
    return this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const system = await client.query<{ id: string }>(
          `
            INSERT INTO hierarchy.systems (group_id, name, owner_id, status)
            VALUES ($1, $2, $3, 'active')
            RETURNING id;
          `,
          [input.workspaceId, chainName, input.createdBy],
        );
        const systemId = system.rows[0]?.id;
        if (!systemId) throw new Error('System insert returned no row');

        const deliveryProject = await client.query<{ id: string }>(
          `
            INSERT INTO hierarchy.delivery_projects (system_id, group_id, name, manager_id, status)
            VALUES ($1, $2, $3, $4, 'active')
            RETURNING id;
          `,
          [systemId, input.workspaceId, chainName, input.createdBy],
        );
        const deliveryProjectId = deliveryProject.rows[0]?.id;
        if (!deliveryProjectId) {
          throw new Error('Delivery project insert returned no row');
        }

        const repository = await client.query<{ id: string }>(
          `
            INSERT INTO hierarchy.repositories (
              delivery_project_id, group_id, name, repo_full_name,
              visibility, created_by, status, provisioned_project_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (provisioned_project_id) DO NOTHING
            RETURNING id;
          `,
          [
            deliveryProjectId,
            input.workspaceId,
            input.name,
            input.repoFullName,
            input.visibility,
            input.createdBy,
            input.projectStatus === 'provisioned' ? 'active' : 'pending',
            input.projectId,
          ],
        );

        const repositoryId = repository.rows[0]?.id;
        if (!repositoryId) {
          // Another writer linked this project first. Roll back our redundant
          // system/delivery-project rows rather than leaving them orphaned.
          await client.query('ROLLBACK');
          return null;
        }

        await client.query('COMMIT');
        return { repositoryId, deliveryProjectId };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }
}
