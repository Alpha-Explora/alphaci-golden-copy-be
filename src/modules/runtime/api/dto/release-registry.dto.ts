import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const REPO = /^[\w.-]+\/[\w.-]+$/;

export class ReleaseArtifactDto {
  @IsIn(['backend', 'frontend', 'standalone'])
  slot!: 'backend' | 'frontend' | 'standalone';

  /** image@sha256:<64 hex>; tags are refused. */
  @IsString()
  @MaxLength(512)
  reference!: string;
}

export class WorkflowRunDto {
  @IsIn(['github_actions'])
  provider!: 'github_actions';

  @Matches(REPO)
  repo!: string;

  @Matches(/^[0-9]{1,20}$/)
  runId!: string;

  @Matches(/^https:\/\//)
  @MaxLength(512)
  url!: string;
}

/** New-mode release registration: the request names its source environment. */
export class RegisterReleaseDto {
  @Matches(REPO, { message: 'repoFullName must be owner/repo' })
  repoFullName!: string;

  @IsUUID()
  sourceEnvironmentId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  sourceBranch!: string;

  @Matches(/^[0-9a-f]{40}$/, {
    message: 'commitSha must be the full 40-character commit SHA',
  })
  commitSha!: string;

  @ValidateNested({ each: true })
  @ArrayMaxSize(3)
  @Type(() => ReleaseArtifactDto)
  artifacts!: ReleaseArtifactDto[];

  @ValidateNested()
  @Type(() => WorkflowRunDto)
  workflowRun!: WorkflowRunDto;
}

export class ManifestSignatureDto {
  @IsString()
  @MaxLength(64)
  algorithm!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  keyId!: string;

  @IsString()
  @MaxLength(4096)
  value!: string;
}

export class AttachManifestDto {
  @Matches(REPO, { message: 'repoFullName must be owner/repo' })
  repoFullName!: string;

  @IsObject()
  manifest!: Record<string, unknown>;

  @Matches(/^[0-9a-f]{64}$/)
  manifestSha256!: string;

  @ValidateNested()
  @Type(() => ManifestSignatureDto)
  signature!: ManifestSignatureDto;
}

const STATUSES = ['deploying', 'healthy', 'failed', 'rolled_back'] as const;

export class ReportDeploymentStatusDto {
  @IsIn(STATUSES)
  status!: (typeof STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  detail?: string;
}

export class CiReportDeploymentStatusDto extends ReportDeploymentStatusDto {
  @Matches(REPO, { message: 'repoFullName must be owner/repo' })
  repoFullName!: string;
}

export class PromoteReleaseDto {
  @IsUUID()
  releaseId!: string;
}

export class CreateOnpremHostDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}
