import type {
  TenantDeploymentMode,
  TenantMembershipRole,
} from '#kernel/tenancy/tenant-context.port.js';

export type TenantKind = 'customer' | 'institution' | 'enterprise';
export type TenantStatus = 'active' | 'suspended' | 'archived';
export type TenantMembershipStatus =
  'invited' | 'active' | 'suspended' | 'removed';

export interface TenantRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: TenantKind;
  readonly status: TenantStatus;
}

export interface TenantMembershipRecord {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantMembershipRole;
  readonly status: TenantMembershipStatus;
}

export interface ProvisionTenantInput {
  /** Operator-provided mapping; the database must not silently choose it. */
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: TenantKind;
  readonly deploymentMode: TenantDeploymentMode;
  readonly initialMembership: {
    readonly userId: string;
    readonly role?: TenantMembershipRole;
  };
}

export interface ProvisionedTenant extends TenantRecord {
  readonly deploymentMode: TenantDeploymentMode;
}

/**
 * Backfill selection is intentionally row-explicit. There is no "all rows in
 * this database" mode: a deployment boundary alone is not proof that every
 * legacy row belongs to the operator-supplied tenant.
 */
export interface LegacyScopeSelection {
  readonly kind: 'explicit-ids';
  readonly workspaceIds: readonly string[];
  readonly projectIds: readonly string[];
  readonly workflowGenerationIds?: readonly string[];
  readonly providerConnectionIds?: readonly string[];
  readonly ciRunReportIds?: readonly string[];
}

export interface BackfillWorkspaceScopeInput {
  readonly tenantId: string;
  readonly deploymentMode: TenantDeploymentMode;
  readonly selection: LegacyScopeSelection;
  readonly dryRun?: boolean;
}

export interface BackfillSummary {
  readonly tenantId: string;
  readonly dryRun: boolean;
  readonly workspacesSelected: number;
  readonly projectsSelected: number;
  readonly workspacesWouldChange: number;
  readonly projectsWouldChange: number;
  readonly workspacesUpdated: number;
  readonly projectsUpdated: number;
  readonly workflowGenerationsSelected: number;
  readonly providerConnectionsSelected: number;
  readonly ciRunReportsSelected: number;
  readonly workflowGenerationsWouldChange: number;
  readonly providerConnectionsWouldChange: number;
  readonly ciRunReportsWouldChange: number;
  readonly workflowGenerationsUpdated: number;
  readonly providerConnectionsUpdated: number;
  readonly ciRunReportsUpdated: number;
}

export const TENANCY_REPOSITORY = Symbol('TenancyRepository');

export interface TenantProvisioningRepository {
  findActiveTenants(): Promise<readonly TenantRecord[]>;
  findActiveMembershipsForUser(
    userId: string,
    tenantId?: string,
  ): Promise<readonly TenantMembershipRecord[]>;
  provisionTenant(input: ProvisionTenantInput): Promise<TenantRecord>;
  backfillWorkspaceScope(
    input: BackfillWorkspaceScopeInput,
  ): Promise<BackfillSummary>;
}

export class TenancySchemaUnavailableError extends Error {
  constructor() {
    super(
      'The tenancy schema or tenant scope columns are not available in this database',
    );
    this.name = 'TenancySchemaUnavailableError';
  }
}

export class TenantProvisioningConflictError extends Error {
  constructor(message = 'Tenant or membership already exists') {
    super(message);
    this.name = 'TenantProvisioningConflictError';
  }
}

export class TenantScopeConflictError extends Error {
  constructor(
    message = 'A selected legacy row already belongs to another tenant',
  ) {
    super(message);
    this.name = 'TenantScopeConflictError';
  }
}
