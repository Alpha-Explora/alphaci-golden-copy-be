import { IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';

export class SetupExistingRepoPrDto {
  @IsString()
  @Matches(/^[^/\s]+\/[^/\s]+$/)
  repoFullName!: string;

  @IsOptional()
  @IsString()
  baseBranch?: string;

  @IsString()
  projectTypeId!: string;

  @IsOptional()
  @IsString()
  workflowRecipeId?: string;

  @IsString()
  serviceName!: string;

  @IsOptional()
  @IsString()
  servicePath?: string;

  @IsOptional()
  @IsString()
  outputFileName?: string;

  @IsOptional()
  @IsString()
  nodeVersion?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  coverageThreshold?: number;
}
