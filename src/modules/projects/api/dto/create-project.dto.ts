import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsPositive,
  Matches,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { DeploymentProviderId } from '#kernel/ports/deployment-runtime.port';

/** Rejects C0/C1 control characters (incl. newlines and tabs). */
export const PROJECT_NAME_PATTERN = /^[^\p{Cc}]*$/u;

export class DeploymentProvisioningEnvVarDto {
  @IsString()
  @MinLength(2)
  @MaxLength(128)
  key!: string;

  @IsString()
  @MaxLength(16384)
  value!: string;
}

export class DeploymentProvisioningEnvSetDto {
  /**
   * Deployment lane these values apply to. `preview` is always scoped to one
   * branch; `production` carries none, because the provider resolves it from
   * the project's own production branch.
   */
  @IsIn(['production', 'preview'])
  lane!: 'production' | 'preview';

  /**
   * Branch for the preview lane. Omitted means "the branch this target
   * tracks", which is what the create-project wizard wants — it is configuring
   * the branch it just set up.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  gitBranch?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeploymentProvisioningEnvVarDto)
  vars!: DeploymentProvisioningEnvVarDto[];
}

export class DeploymentProvisioningTargetDto {
  @IsOptional()
  @IsIn(['create', 'register_existing'])
  action?: 'create' | 'register_existing';

  @IsIn(['backend', 'frontend', 'standalone'])
  slot!: 'backend' | 'frontend' | 'standalone';

  // Provider ids are plugin data. Runtime validates that a registered,
  // enabled provider can serve the requested slot; this DTO only validates
  // the transport-safe id shape so adding a provider does not require editing
  // this class.
  @Matches(/^[a-z][a-z0-9-]*$/)
  provider!: DeploymentProviderId;

  @IsIn(['byo', 'flowci_managed'])
  ownershipMode!: 'byo' | 'flowci_managed';

  @IsOptional()
  @IsString()
  providerConnectionId?: string;

  @IsOptional()
  @IsString()
  projectName?: string;

  @IsOptional()
  @IsString()
  providerProjectId?: string;

  @IsOptional()
  @IsString()
  providerProjectName?: string;

  @IsOptional()
  @IsString()
  branchName?: string;

  @IsOptional()
  @IsString()
  rootDirectory?: string;

  @IsOptional()
  @IsString()
  buildCommand?: string;

  @IsOptional()
  @IsString()
  startCommand?: string;

  @IsOptional()
  @IsIn(['managed_image', 'byo_image', 'native_git', 'existing_service'])
  renderDeployMethod?:
    | 'managed_image'
    | 'byo_image'
    | 'native_git'
    | 'existing_service';

  @IsOptional()
  @IsIn(['web_service', 'private_service', 'background_worker', 'cron_job'])
  renderServiceType?:
    | 'web_service'
    | 'private_service'
    | 'background_worker'
    | 'cron_job';

  @IsOptional()
  @IsIn(['node', 'python', 'ruby', 'go', 'rust', 'elixir', 'docker'])
  renderRuntime?:
    | 'node'
    | 'python'
    | 'ruby'
    | 'go'
    | 'rust'
    | 'elixir'
    | 'docker';

  @IsOptional()
  @IsString()
  renderInstanceType?: string;

  @IsOptional()
  @IsString()
  renderRegion?: string;

  @IsOptional()
  @IsIn(['dev', 'test', 'uat', 'production'])
  renderEnvironmentName?: 'dev' | 'test' | 'uat' | 'production';

  @IsOptional()
  @IsString()
  dockerContext?: string;

  @IsOptional()
  @IsString()
  dockerfilePath?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeploymentProvisioningEnvSetDto)
  env?: DeploymentProvisioningEnvSetDto[];
}

export class DeploymentProvisioningVariableGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @Matches(/^[a-z][a-z0-9-]*$/)
  provider!: DeploymentProviderId;

  @IsOptional()
  @IsIn(['all', 'selected'])
  appliesTo?: 'all' | 'selected';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  targetBranches?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeploymentProvisioningEnvSetDto)
  env!: DeploymentProvisioningEnvSetDto[];
}

export class DeploymentProvisioningRequestDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeploymentProvisioningVariableGroupDto)
  variableGroups?: DeploymentProvisioningVariableGroupDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeploymentProvisioningEnvSetDto)
  sharedEnv?: DeploymentProvisioningEnvSetDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeploymentProvisioningTargetDto)
  targets!: DeploymentProvisioningTargetDto[];
}

export class MicroserviceSlotDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  projectTypeId!: string;

  @IsOptional()
  @IsString()
  workflowRecipeId?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  serviceName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  servicePath?: string;
}

export class MicroservicesConfigDto {
  @ValidateNested()
  @Type(() => MicroserviceSlotDto)
  backend!: MicroserviceSlotDto;

  @ValidateNested()
  @Type(() => MicroserviceSlotDto)
  frontend!: MicroserviceSlotDto;
}

export class MultiRepoConfigDto {
  @ValidateNested()
  @Type(() => MicroserviceSlotDto)
  backend!: MicroserviceSlotDto;

  @ValidateNested()
  @Type(() => MicroserviceSlotDto)
  frontend!: MicroserviceSlotDto;
}

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  repoName!: string;

  @IsIn(['private', 'public'])
  visibility!: 'private' | 'public';

  @IsOptional()
  @IsIn(['personal', 'organization'])
  ownerType?: 'personal' | 'organization';

  @IsOptional()
  @IsInt()
  @IsPositive()
  installationId?: number;

  // Catalog IDs ('mono', 'multi') and canonical IDs ('monorepo', 'multi-repo')
  // are both accepted; the service normalizes via normalizeRepoShape().
  @IsOptional()
  @IsIn([
    'standalone',
    'mono',
    'monorepo',
    'multi',
    'multi-repo',
    'microservices',
  ])
  repoShape?: string;

  @IsString()
  @MinLength(1)
  projectTypeId!: string;

  @IsOptional()
  @IsString()
  workflowRecipeId?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  serviceName!: string;

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

  @IsOptional()
  @ValidateNested()
  @Type(() => MicroservicesConfigDto)
  microservicesConfig?: MicroservicesConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MultiRepoConfigDto)
  multiRepoConfig?: MultiRepoConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeploymentProvisioningRequestDto)
  deploymentProvisioning?: DeploymentProvisioningRequestDto;

  /**
   * Group/workspace to create this project inside. When the "Create project"
   * form is launched from a group, its id is passed here so the project is
   * owned by that group. Omitted → the caller's default (personal) workspace.
   */
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  /**
   * Existing hierarchy delivery project ("Project folder") to link this
   * repository into, instead of auto-creating a new system/delivery-project
   * chain. Validated up front (exists, active, same workspace, caller may
   * create there) before any GitHub call. For a multi-repo/microservices
   * shape, both repos in the pair are linked to this same delivery project.
   */
  @IsOptional()
  @IsUUID()
  deliveryProjectId?: string;

  /**
   * Name of the Project (hierarchy delivery project) a NEW repository is filed
   * under, independent of the repository name. Trimmed; 1-80 chars; no control
   * characters. Optional: omitted keeps the legacy naming. Ignored when
   * `deliveryProjectId` is given (the repository joins that Project). Must be
   * unique among the team's non-archived Projects (case-insensitive) or the
   * request fails 409 PROJECT_NAME_TAKEN before any GitHub repository exists.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(PROJECT_NAME_PATTERN, {
    message: 'projectName must not contain control characters',
  })
  projectName?: string;
}
