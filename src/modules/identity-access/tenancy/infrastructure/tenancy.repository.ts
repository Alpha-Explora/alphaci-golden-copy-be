import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';

import { DatabaseService } from '#kernel/db/database.service.js';
import {
  TenantProvisioningConflictError,
  TenantScopeConflictError,
  TenancySchemaUnavailableError,
  type BackfillSummary,
  type BackfillWorkspaceScopeInput,
  type ProvisionTenantInput,
  type TenantMembershipRecord,
  type TenantProvisioningRepository,
  type TenantRecord,
} from '../contracts/tenant-provisioning.contract.js';

interface TenantRow extends QueryResultRow {
  id: string;
  slug: string;
  name: string;
  kind: TenantRecord['kind'];
  status: TenantRecord['status'];
}

interface MembershipRow extends QueryResultRow {
  tenant_id: string;
  user_id: string;
  role: TenantMembershipRecord['role'];
  status: TenantMembershipRecord['status'];
}

interface ScopedRow extends QueryResultRow {
  id: string;
  tenant_id: string | null;
  user_id?: string;
  owner_user_id?: string;
  workspace_id?: string | null;
  workspace_tenant_id?: string | null;
}

@Injectable()
export class TenancyRepository implements TenantProvisioningRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findActiveTenants(): Promise<readonly TenantRecord[]> {
    const result = await this.databaseService.query<TenantRow>(`
      SELECT id, slug, name, kind, status
      FROM tenancy.tenants
      WHERE status = 'active'
      ORDER BY created_at ASC, id ASC;
    `);

    return result.rows.map((row) => this.toTenant(row));
  }

  async findActiveMembershipsForUser(
    userId: string,
    tenantId?: string,
  ): Promise<readonly TenantMembershipRecord[]> {
    const result = await this.databaseService.query<MembershipRow>(
      `
        SELECT
          membership.tenant_id,
          membership.user_id,
          membership.role,
          membership.status
        FROM tenancy.tenant_memberships AS membership
        JOIN tenancy.tenants AS tenant
          ON tenant.id = membership.tenant_id
        WHERE membership.user_id = $1
          AND membership.status = 'active'
          AND tenant.status = 'active'
          AND ($2::uuid IS NULL OR membership.tenant_id = $2::uuid)
        ORDER BY membership.tenant_id ASC;
      `,
      [userId, tenantId ?? null],
    );

    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role,
      status: row.status,
    }));
  }

  async provisionTenant(input: ProvisionTenantInput): Promise<TenantRecord> {
    try {
      return await this.databaseService.withTransaction(async (client) => {
        if (input.deploymentMode === 'enterprise') {
          // The service-level check gives callers a fast failure, but it is
          // outside this transaction. Serialize Enterprise provisioning here
          // so two operators cannot both observe an empty database and create
          // two active tenants concurrently.
          await client.query(
            `
              SELECT pg_advisory_xact_lock(
                hashtext('alphaci.enterprise.single-active-tenant')
              );
            `,
          );
          const activeTenants = await client.query<{ id: string }>(
            `
              SELECT id
              FROM tenancy.tenants
              WHERE status = 'active'
              FOR UPDATE;
            `,
          );
          if (activeTenants.rows.length > 0) {
            throw new TenantProvisioningConflictError(
              'An Enterprise database may contain only one active tenant',
            );
          }
        }

        const tenantResult = await client.query<TenantRow>(
          `
            INSERT INTO tenancy.tenants (id, slug, name, kind)
            VALUES ($1::uuid, $2, $3, $4)
            RETURNING id, slug, name, kind, status;
          `,
          [input.tenantId, input.slug, input.name, input.kind],
        );

        const tenant = tenantResult.rows[0];
        if (!tenant) {
          throw new Error('Tenant INSERT returned no row');
        }

        await client.query(
          `
            INSERT INTO tenancy.tenant_memberships
              (tenant_id, user_id, role, status)
            VALUES ($1::uuid, $2::uuid, $3, 'active');
          `,
          [
            input.tenantId,
            input.initialMembership.userId,
            input.initialMembership.role ?? 'owner',
          ],
        );

        return this.toTenant(tenant);
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new TenantProvisioningConflictError();
      }
      if (this.isMissingTenancySchema(error)) {
        throw new TenancySchemaUnavailableError();
      }
      throw error;
    }
  }

  async backfillWorkspaceScope(
    input: BackfillWorkspaceScopeInput,
  ): Promise<BackfillSummary> {
    try {
      return await this.databaseService.withTransaction(async (client) => {
        await this.assertActiveTenant(client, input.tenantId);

        const selection = input.selection;
        const workspaceIds = this.uniqueIds(selection.workspaceIds);
        const projectIds = this.uniqueIds(selection.projectIds);

        const workspaces = await this.loadScopedRows(
          client,
          'orgs.workspaces',
          workspaceIds,
        );
        const projects = await this.loadScopedRows(
          client,
          'projects.provisioned_projects',
          projectIds,
        );
        const workflowGenerations = await this.loadScopedRows(
          client,
          'workflow.workflow_generations',
          this.uniqueIds(selection.workflowGenerationIds ?? []),
        );
        const providerConnections = await this.loadScopedRows(
          client,
          'env_provisioning.provider_connections',
          this.uniqueIds(selection.providerConnectionIds ?? []),
        );
        const ciRunReports = await this.loadScopedRows(
          client,
          'workflow.ci_run_reports',
          this.uniqueIds(selection.ciRunReportIds ?? []),
        );

        this.assertAllSelectedRowsExist(workspaces, workspaceIds, 'workspace');
        this.assertAllSelectedRowsExist(projects, projectIds, 'project');
        this.assertAllSelectedRowsExist(
          workflowGenerations,
          this.uniqueIds(selection.workflowGenerationIds ?? []),
          'workflow generation',
        );
        this.assertAllSelectedRowsExist(
          providerConnections,
          this.uniqueIds(selection.providerConnectionIds ?? []),
          'provider connection',
        );
        this.assertAllSelectedRowsExist(
          ciRunReports,
          this.uniqueIds(selection.ciRunReportIds ?? []),
          'CI run report',
        );
        this.assertNoForeignScope(workspaces, input.tenantId);
        this.assertNoForeignScope(projects, input.tenantId);
        this.assertNoForeignScope(workflowGenerations, input.tenantId);
        this.assertNoForeignScope(providerConnections, input.tenantId);
        this.assertNoForeignScope(ciRunReports, input.tenantId);
        this.assertProjectWorkspaceScope(
          projects,
          input.tenantId,
          new Set(workspaceIds),
        );
        await this.assertTenantMembership(
          client,
          [
            ...workspaces.flatMap((row) =>
              row.owner_user_id ? [{ ...row, user_id: row.owner_user_id }] : [],
            ),
            ...projects,
          ],
          input.tenantId,
        );
        await this.assertTenantMembership(
          client,
          [...workflowGenerations, ...providerConnections],
          input.tenantId,
        );
        await this.assertTenantMembership(client, ciRunReports, input.tenantId);

        const workspacesWouldChange = workspaces.filter(
          (row) => row.tenant_id === null,
        ).length;
        const projectsWouldChange = projects.filter(
          (row) => row.tenant_id === null,
        ).length;
        const workflowGenerationsWouldChange = workflowGenerations.filter(
          (row) => row.tenant_id === null,
        ).length;
        const providerConnectionsWouldChange = providerConnections.filter(
          (row) => row.tenant_id === null,
        ).length;
        const ciRunReportsWouldChange = ciRunReports.filter(
          (row) => row.tenant_id === null,
        ).length;

        if (input.dryRun) {
          return {
            tenantId: input.tenantId,
            dryRun: true,
            workspacesSelected: workspaces.length,
            projectsSelected: projects.length,
            workspacesWouldChange,
            projectsWouldChange,
            workspacesUpdated: 0,
            projectsUpdated: 0,
            workflowGenerationsSelected: workflowGenerations.length,
            providerConnectionsSelected: providerConnections.length,
            ciRunReportsSelected: ciRunReports.length,
            workflowGenerationsWouldChange,
            providerConnectionsWouldChange,
            ciRunReportsWouldChange,
            workflowGenerationsUpdated: 0,
            providerConnectionsUpdated: 0,
            ciRunReportsUpdated: 0,
          };
        }

        const workspaceUpdate = await this.updateScope(
          client,
          'orgs.workspaces',
          this.idsForUpdate(workspaces),
          input.tenantId,
        );
        const projectUpdate = await this.updateScope(
          client,
          'projects.provisioned_projects',
          this.idsForUpdate(projects),
          input.tenantId,
        );
        const workflowGenerationUpdate = await this.updateScope(
          client,
          'workflow.workflow_generations',
          this.idsForUpdate(workflowGenerations),
          input.tenantId,
        );
        const providerConnectionUpdate = await this.updateScope(
          client,
          'env_provisioning.provider_connections',
          this.idsForUpdate(providerConnections),
          input.tenantId,
        );
        const ciRunReportUpdate = await this.updateScope(
          client,
          'workflow.ci_run_reports',
          this.idsForUpdate(ciRunReports),
          input.tenantId,
        );

        return {
          tenantId: input.tenantId,
          dryRun: false,
          workspacesSelected: workspaces.length,
          projectsSelected: projects.length,
          workspacesWouldChange,
          projectsWouldChange,
          workspacesUpdated: workspaceUpdate,
          projectsUpdated: projectUpdate,
          workflowGenerationsSelected: workflowGenerations.length,
          providerConnectionsSelected: providerConnections.length,
          ciRunReportsSelected: ciRunReports.length,
          workflowGenerationsWouldChange,
          providerConnectionsWouldChange,
          ciRunReportsWouldChange,
          workflowGenerationsUpdated: workflowGenerationUpdate,
          providerConnectionsUpdated: providerConnectionUpdate,
          ciRunReportsUpdated: ciRunReportUpdate,
        };
      });
    } catch (error) {
      if (this.isMissingTenancySchema(error)) {
        throw new TenancySchemaUnavailableError();
      }
      throw error;
    }
  }

  private async assertActiveTenant(
    client: PoolClient,
    tenantId: string,
  ): Promise<void> {
    const result = await client.query<{ id: string }>(
      `
        SELECT id
        FROM tenancy.tenants
        WHERE id = $1::uuid AND status = 'active'
        FOR SHARE;
      `,
      [tenantId],
    );

    if (!result.rows[0]) {
      throw new TenantScopeConflictError();
    }
  }

  private async loadScopedRows(
    client: PoolClient,
    table:
      | 'orgs.workspaces'
      | 'projects.provisioned_projects'
      | 'workflow.workflow_generations'
      | 'env_provisioning.provider_connections'
      | 'workflow.ci_run_reports',
    ids: readonly string[] | null,
  ): Promise<ScopedRow[]> {
    if (table === 'workflow.workflow_generations') {
      return this.loadSimpleScopedRows(
        client,
        table,
        ids,
        'workflow generation',
      );
    }
    if (
      table === 'env_provisioning.provider_connections' ||
      table === 'workflow.ci_run_reports'
    ) {
      return this.loadSimpleScopedRows(
        client,
        table,
        ids,
        table === 'workflow.ci_run_reports'
          ? 'CI run report'
          : 'provider connection',
      );
    }

    const projectWorkspaceJoin =
      table === 'projects.provisioned_projects'
        ? 'LEFT JOIN orgs.workspaces AS workspace ON workspace.id = project.workspace_id'
        : '';
    const select =
      table === 'projects.provisioned_projects'
        ? 'project.id, project.tenant_id, project.user_id, project.workspace_id, workspace.tenant_id AS workspace_tenant_id'
        : 'workspace.id, workspace.tenant_id, workspace.owner_user_id';
    const from =
      table === 'projects.provisioned_projects'
        ? `FROM ${table} AS project ${projectWorkspaceJoin}`
        : `FROM ${table} AS workspace`;
    const orderBy =
      table === 'projects.provisioned_projects' ? 'project.id' : 'workspace.id';

    const result =
      ids === null
        ? await client.query<ScopedRow>(
            `SELECT ${select} ${from} ORDER BY ${orderBy} ASC;`,
          )
        : await client.query<ScopedRow>(
            `
            SELECT ${select}
            ${from}
            WHERE ${table === 'projects.provisioned_projects' ? 'project' : 'workspace'}.id = ANY($1::uuid[])
            ORDER BY ${orderBy} ASC;
          `,
            [ids],
          );

    return result.rows;
  }

  private async loadSimpleScopedRows(
    client: PoolClient,
    table:
      | 'workflow.workflow_generations'
      | 'env_provisioning.provider_connections'
      | 'workflow.ci_run_reports',
    ids: readonly string[] | null,
    label: string,
  ): Promise<ScopedRow[]> {
    const query =
      ids === null
        ? `SELECT id, tenant_id, user_id FROM ${table} ORDER BY id ASC;`
        : `
            SELECT id, tenant_id, user_id
            FROM ${table}
            WHERE id = ANY($1::uuid[])
            ORDER BY id ASC;
          `;
    const result =
      ids === null
        ? await client.query<ScopedRow>(query)
        : await client.query<ScopedRow>(query, [ids]);
    if (!result.rows.every((row) => row.user_id)) {
      throw new TenantScopeConflictError(
        `A selected ${label} row has no account owner`,
      );
    }
    return result.rows;
  }

  private async updateScope(
    client: PoolClient,
    table:
      | 'orgs.workspaces'
      | 'projects.provisioned_projects'
      | 'workflow.workflow_generations'
      | 'env_provisioning.provider_connections'
      | 'workflow.ci_run_reports',
    ids: readonly string[],
    tenantId: string,
  ): Promise<number> {
    if (ids.length === 0) return 0;

    const result = await client.query(
      `
        UPDATE ${table}
        SET tenant_id = $1::uuid
        WHERE id = ANY($2::uuid[]) AND tenant_id IS NULL;
      `,
      [tenantId, ids],
    );

    return result.rowCount ?? 0;
  }

  private async assertTenantMembership(
    client: PoolClient,
    rows: readonly ScopedRow[],
    tenantId: string,
  ): Promise<void> {
    const userIds = this.uniqueIds(
      rows.flatMap((row) => (row.user_id ? [row.user_id] : [])),
    );
    if (userIds.length === 0) return;

    const result = await client.query<{ user_id: string }>(
      `
        SELECT DISTINCT user_id
        FROM tenancy.tenant_memberships
        WHERE tenant_id = $1::uuid
          AND user_id = ANY($2::uuid[])
          AND status = 'active';
      `,
      [tenantId, userIds],
    );
    const activeUsers = new Set(result.rows.map((row) => row.user_id));
    if (userIds.some((userId) => !activeUsers.has(userId))) {
      throw new TenantScopeConflictError(
        'A selected account-owned row has no active membership in the target tenant',
      );
    }
  }

  private assertAllSelectedRowsExist(
    rows: readonly ScopedRow[],
    ids: readonly string[] | null,
    kind:
      | 'workspace'
      | 'project'
      | 'workflow generation'
      | 'provider connection'
      | 'CI run report',
  ): void {
    if (ids !== null && rows.length !== ids.length) {
      throw new TenantScopeConflictError(
        `One or more selected ${kind} rows do not exist in this database`,
      );
    }
  }

  private assertNoForeignScope(
    rows: readonly ScopedRow[],
    tenantId: string,
  ): void {
    if (
      rows.some((row) => row.tenant_id !== null && row.tenant_id !== tenantId)
    ) {
      throw new TenantScopeConflictError();
    }
  }

  private assertProjectWorkspaceScope(
    rows: readonly ScopedRow[],
    tenantId: string,
    selectedWorkspaceIds: ReadonlySet<string>,
  ): void {
    if (
      rows.some(
        (row) =>
          row.workspace_tenant_id !== undefined &&
          ((row.workspace_tenant_id !== null &&
            row.workspace_tenant_id !== tenantId) ||
            (row.workspace_tenant_id === null &&
              row.workspace_id !== null &&
              row.workspace_id !== undefined &&
              !selectedWorkspaceIds.has(row.workspace_id))),
      )
    ) {
      throw new TenantScopeConflictError(
        'A selected project belongs to a foreign or unscoped workspace; select its workspace explicitly before backfill',
      );
    }
  }

  private idsForUpdate(rows: readonly ScopedRow[]): string[] {
    return rows.filter((row) => row.tenant_id === null).map((row) => row.id);
  }

  private uniqueIds(ids: readonly string[]): string[] {
    return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  }

  private toTenant(row: TenantRow): TenantRecord {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      status: row.status,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return this.errorCode(error) === '23505';
  }

  private isMissingTenancySchema(error: unknown): boolean {
    const code = this.errorCode(error);
    return code === '42P01' || code === '42703' || code === '3F000';
  }

  private errorCode(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return '';
    }

    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : '';
  }
}
