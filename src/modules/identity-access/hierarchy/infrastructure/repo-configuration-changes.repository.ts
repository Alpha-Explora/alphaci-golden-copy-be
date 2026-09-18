import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type {
  ApprovalState,
  ConfigurationAction,
  ConfigurationSyncState,
  ConfigurationType,
  EnvironmentScope,
} from '../domain/hierarchy.types';

export interface ConfigurationChangeRecord {
  id: string;
  repositoryId: string;
  requestedBy: string;
  environmentScope: EnvironmentScope;
  configurationType: ConfigurationType;
  action: ConfigurationAction;
  variableName: string;
  approvalState: ApprovalState;
  githubSyncState: ConfigurationSyncState;
  createdAt: string;
}

interface ConfigurationChangeRow {
  id: string;
  repository_id: string;
  requested_by: string;
  environment_scope: EnvironmentScope;
  configuration_type: ConfigurationType;
  action: ConfigurationAction;
  variable_name: string;
  approval_state: ApprovalState;
  github_sync_state: ConfigurationSyncState;
  created_at: string;
}

/**
 * NOTE: this table (hierarchy.repository_configuration_changes) is
 * structurally incapable of storing a secret/variable *value* — name only
 * (hierarchy persistence contract, §3.1 file 4 acceptance check). Never add a value column here.
 */
@Injectable()
export class RepoConfigurationChangesRepository {
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  async record(input: {
    repositoryId: string;
    requestedBy: string;
    environmentScope: EnvironmentScope;
    configurationType: ConfigurationType;
    action: ConfigurationAction;
    variableName: string;
    approvalState: ApprovalState;
    githubSyncState: ConfigurationSyncState;
  }): Promise<ConfigurationChangeRecord> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<ConfigurationChangeRow>(
      `
        INSERT INTO hierarchy.repository_configuration_changes (
          repository_id, requested_by, environment_scope, configuration_type,
          action, variable_name, approval_state, github_sync_state
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8
        FROM hierarchy.repositories AS repository
        JOIN orgs.workspaces AS workspace ON workspace.id = repository.group_id
        WHERE repository.id = $1
          AND workspace.tenant_id = $9::uuid
        RETURNING id, repository_id, requested_by, environment_scope, configuration_type,
          action, variable_name, approval_state, github_sync_state, created_at;
      `,
      [
        input.repositoryId,
        input.requestedBy,
        input.environmentScope,
        input.configurationType,
        input.action,
        input.variableName,
        input.approvalState,
        input.githubSyncState,
        tenantId,
      ],
    );
    const row = result.rows[0];
    if (!row)
      throw new Error('Configuration change insert did not return a row');
    return this.toRecord(row);
  }

  /**
   * Distinct current names — "list metadata only, never values" (configuration metadata contract).
   * Only the *latest* change per (name, environment_scope) is considered;
   * names whose latest action was 'delete' are excluded (no longer present).
   */
  async listCurrentNames(
    repositoryId: string,
    configurationType: ConfigurationType,
  ): Promise<
    Array<{
      name: string;
      environmentScope: EnvironmentScope;
      updatedAt: string;
    }>
  > {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{
      variable_name: string;
      environment_scope: EnvironmentScope;
      action: ConfigurationAction;
      updated_at: string;
    }>(
      `
        SELECT DISTINCT ON (variable_name, environment_scope)
          variable_name, environment_scope, action, created_at AS updated_at
        FROM hierarchy.repository_configuration_changes AS configuration_change
        JOIN hierarchy.repositories AS repository ON repository.id = configuration_change.repository_id
        JOIN orgs.workspaces AS workspace ON workspace.id = repository.group_id
        WHERE configuration_change.repository_id = $1
          AND configuration_change.configuration_type = $2
          AND workspace.tenant_id = $3::uuid
        ORDER BY configuration_change.variable_name,
          configuration_change.environment_scope, configuration_change.created_at DESC
      `,
      [repositoryId, configurationType, tenantId],
    );
    return result.rows
      .filter((row) => row.action !== 'delete')
      .map((row) => ({
        name: row.variable_name,
        environmentScope: row.environment_scope,
        updatedAt: row.updated_at,
      }));
  }

  private toRecord(row: ConfigurationChangeRow): ConfigurationChangeRecord {
    return {
      id: row.id,
      repositoryId: row.repository_id,
      requestedBy: row.requested_by,
      environmentScope: row.environment_scope,
      configurationType: row.configuration_type,
      action: row.action,
      variableName: row.variable_name,
      approvalState: row.approval_state,
      githubSyncState: row.github_sync_state,
      createdAt: row.created_at,
    };
  }

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }
    return this.tenantContext.require().tenantId;
  }
}
