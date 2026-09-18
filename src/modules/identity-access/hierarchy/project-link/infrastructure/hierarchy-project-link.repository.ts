import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';

export interface LinkProjectInput {
  projectId: string;
  workspaceId: string;
  /** Display name for the system / delivery project / repository nodes. */
  name: string;
  repoFullName: string;
  visibility: 'private' | 'public';
  createdBy: string;
  /** provisioned_projects.status — maps to the repository row's status. */
  projectStatus: string;
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
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  /** True when the workspace is a Group (team), not a personal workspace. */
  async isTeamWorkspace(workspaceId: string): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ exists: boolean }>(
      `
        SELECT TRUE AS exists
        FROM orgs.workspaces
        WHERE id = $1 AND kind = 'team' AND tenant_id = $2::uuid
        LIMIT 1;
      `,
      [workspaceId, tenantId],
    );
    return result.rows.length > 0;
  }

  /** Existing hierarchy repository id for this project, if already linked. */
  async findLinkedRepositoryId(projectId: string): Promise<string | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ id: string }>(
      `
        SELECT repository.id
        FROM hierarchy.repositories AS repository
        JOIN orgs.workspaces AS workspace ON workspace.id = repository.group_id
        JOIN projects.provisioned_projects AS project
          ON project.id = repository.provisioned_project_id
        WHERE repository.provisioned_project_id = $1
          AND project.tenant_id = $2::uuid
          AND workspace.tenant_id = $2::uuid
        LIMIT 1;
      `,
      [projectId, tenantId],
    );
    return result.rows[0]?.id ?? null;
  }

  /**
   * Creates system -> delivery project -> repository for `projectId` and
   * returns the repository id.
   *
   * The whole chain is one transaction: a half-built tree (a system with no
   * repository) would show up in the group UI as an empty phantom project.
   * ON CONFLICT DO NOTHING on the final insert makes a concurrent double-link
   * lose harmlessly rather than violating the UNIQUE constraint — the second
   * caller re-reads the winner's row.
   */
  async link(input: LinkProjectInput): Promise<string | null> {
    const tenantId = this.requireTenantId();
    return this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const system = await client.query<{ id: string }>(
          `
            INSERT INTO hierarchy.systems (group_id, name, owner_id, status)
            SELECT $1, $2, $3, 'active'
            FROM orgs.workspaces AS workspace
            WHERE workspace.id = $1
              AND workspace.kind = 'team'
              AND workspace.tenant_id = $4::uuid
            RETURNING id;
          `,
          [input.workspaceId, input.name, input.createdBy, tenantId],
        );
        const systemId = system.rows[0]?.id;
        if (!systemId) throw new Error('System insert returned no row');

        const deliveryProject = await client.query<{ id: string }>(
          `
            INSERT INTO hierarchy.delivery_projects (system_id, group_id, name, manager_id, status)
            SELECT $1, $2, $3, $4, 'active'
            FROM hierarchy.systems AS system
            JOIN orgs.workspaces AS workspace ON workspace.id = system.group_id
            WHERE system.id = $1
              AND system.group_id = $2
              AND workspace.tenant_id = $5::uuid
            RETURNING id;
          `,
          [systemId, input.workspaceId, input.name, input.createdBy, tenantId],
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
            SELECT $1, $2, $3, $4, $5, $6, $7, $8
            FROM projects.provisioned_projects AS project
            JOIN orgs.workspaces AS workspace ON workspace.id = project.workspace_id
            WHERE project.id = $8::uuid
              AND project.workspace_id = $2
              AND project.tenant_id = $9::uuid
              AND workspace.tenant_id = $9::uuid
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
            tenantId,
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
        return repositoryId;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }
    return this.tenantContext.require().tenantId;
  }
}
