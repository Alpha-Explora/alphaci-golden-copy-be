import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type {
  DeploymentProvisioningRequest,
  DeploymentProvisioningResult,
} from '#kernel/ports/deployment-runtime.port';

/**
 * Hosting request for one repository. The shape and validation are the ones
 * POST /projects uses (CreateProjectRequest.deploymentProvisioning); the class
 * is declared here only because identity-access cannot import a Projects DTO.
 * The nested object is passed through untouched and validated against
 * Projects' own DeploymentProvisioningRequestDto (whitelist + forbidNonWhitelisted)
 * by the provisioning adapter, before any GitHub call.
 */
export class CreateDeliveryProjectRepositoryDto {
  /** GitHub repository name. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string = '';

  /** Private by default; public is allowed exactly as in the wizard. */
  @IsOptional()
  @IsIn(['private', 'public'])
  visibility?: 'private' | 'public';

  /** Stack from GET /catalog/project-options (frontend or backend type). */
  @IsString()
  @MinLength(1)
  projectTypeId: string = '';

  @IsOptional()
  @IsString()
  workflowRecipeId?: string;

  /** Display/service name. Defaults to `name`. */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  serviceName?: string;

  @IsOptional()
  @IsIn(['standalone', 'mono', 'monorepo'])
  repoShape?: 'standalone' | 'mono' | 'monorepo';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  servicePath?: string;

  @IsOptional()
  @IsString()
  nodeVersion?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  coverageThreshold?: number;

  @IsOptional()
  @IsObject()
  tests?: Partial<Record<string, boolean>>;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  outputFileName?: string;

  /**
   * Same shape as CreateProjectRequest.deploymentProvisioning. Omitted: the
   * managed defaults apply (frontend to Vercel, backend to Render).
   */
  @IsOptional()
  @IsObject()
  deploymentProvisioning?: DeploymentProvisioningRequest;
}

/** What the hosting step did, for the UI to show without parsing targets. */
export interface RepositoryHostingSummary {
  /** `skipped` = no hosting was requested or configured. */
  outcome: 'provisioned' | 'partial' | 'failed' | 'skipped';
  /** One entry per hosting target (or env var) that did not succeed. */
  failures: Array<{
    slot: string;
    provider: string;
    reason: string;
  }>;
}

export function summarizeHosting(
  result: DeploymentProvisioningResult,
): RepositoryHostingSummary {
  const outcome =
    result.status === 'completed'
      ? 'provisioned'
      : result.status === 'partial'
        ? 'partial'
        : result.status === 'failed'
          ? 'failed'
          : 'skipped';
  const failures: RepositoryHostingSummary['failures'] = [];
  for (const target of result.targets) {
    if (target.status === 'failed') {
      failures.push({
        slot: target.slot,
        provider: target.provider,
        reason: target.errorSummary ?? 'Hosting provisioning failed',
      });
    }
    for (const env of target.env) {
      for (const variable of env.failed) {
        failures.push({
          slot: target.slot,
          provider: target.provider,
          reason: `${variable.key}: ${variable.errorSummary}`,
        });
      }
    }
  }
  return { outcome, failures };
}
