import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DeploymentProvisioningRequestDto } from './create-project.dto';

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
}
