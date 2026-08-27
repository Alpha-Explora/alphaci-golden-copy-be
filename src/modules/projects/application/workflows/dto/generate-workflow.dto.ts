import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Provider ids are supplied by runtime plugins rather than a closed union. */
export type DeploymentProvider = string;

export interface DeploymentWorkflowTarget {
  slot: 'backend' | 'frontend' | 'standalone';
  provider: DeploymentProvider;
  branchName?: string;
  deploymentStrategy: string;
  rootDirectory?: string;
  dockerContext?: string | null;
  dockerfilePath?: string | null;
  imageName?: string | null;
  renderServiceType?: string | null;
  renderInstanceType?: string | null;
  /** Provider-owned secret mapping; keys are intentionally open-ended. */
  secretNames?: Record<string, string>;
}

export class GenerateWorkflowDto {
  @IsString()
  @Matches(/^[a-z0-9-]+$/)
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
  @Matches(/^[0-9]{2}$/)
  nodeVersion?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  coverageThreshold?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9-]*$/)
  deploymentProvider?: DeploymentProvider;

  deploymentTargets?: DeploymentWorkflowTarget[];

  @IsOptional()
  @IsArray()
  @IsIn(
    [
      'strictProductionApproval',
      'enableUatApproval',
      'disablePlaywright',
      'disableK6',
    ],
    {
      each: true,
    },
  )
  enhancements?: Array<
    | 'strictProductionApproval'
    | 'enableUatApproval'
    | 'disablePlaywright'
    | 'disableK6'
  >;
}
