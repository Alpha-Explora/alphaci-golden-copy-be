import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Matches,
  MinLength,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  DeploymentProvisioningRequestDto,
  PROJECT_NAME_PATTERN,
} from './create-project.dto';

export class SetupProjectDto {
  @IsString()
  @MinLength(1)
  templateId!: string;

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
  @IsArray()
  @IsIn(
    [
      'strictProductionApproval',
      'enableUatApproval',
      'disablePlaywright',
      'disableK6',
    ],
    { each: true },
  )
  enhancements?: Array<
    | 'strictProductionApproval'
    | 'enableUatApproval'
    | 'disablePlaywright'
    | 'disableK6'
  >;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  repoFullName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  outputFileName?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeploymentProvisioningRequestDto)
  deploymentProvisioning?: DeploymentProvisioningRequestDto;

  /** Group/workspace to create this project inside (see CreateProjectDto). */
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  /** Existing delivery project to link this repository into (see CreateProjectDto). */
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
