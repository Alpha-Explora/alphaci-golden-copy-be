import {
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ─── Nested detail DTOs ───────────────────────────────────────────────────────

export class CiReportTestFailureDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  message?: string;
}

export class CiReportLintIssueDto {
  @IsOptional()
  @IsString()
  rule?: string;

  @IsOptional()
  @IsString()
  file?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  line?: number;

  @IsOptional()
  @IsString()
  message?: string;
}

export class CiReportSecurityItemDto {
  @IsOptional()
  @IsString()
  package?: string;

  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  severity?: string;
}

// ─── Top-level result section DTOs ───────────────────────────────────────────

export class CiReportTestResultsDto {
  @IsInt()
  @Min(0)
  passed!: number;

  @IsInt()
  @Min(0)
  failed!: number;

  @IsInt()
  @Min(0)
  total!: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CiReportTestFailureDto)
  failures?: CiReportTestFailureDto[];
}

export class CiReportCoverageDto {
  @IsNumber()
  @Min(0)
  pct!: number;

  @IsNumber()
  @Min(0)
  threshold!: number;
}

export class CiReportLintDto {
  @IsInt()
  @Min(0)
  errors!: number;

  @IsInt()
  @Min(0)
  warnings!: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CiReportLintIssueDto)
  issues?: CiReportLintIssueDto[];
}

export class CiReportSecurityDto {
  @IsInt()
  @Min(0)
  high!: number;

  @IsInt()
  @Min(0)
  critical!: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CiReportSecurityItemDto)
  items?: CiReportSecurityItemDto[];
}

export class CiReportResultsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportTestResultsDto)
  tests?: CiReportTestResultsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportCoverageDto)
  coverage?: CiReportCoverageDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportLintDto)
  lint?: CiReportLintDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportSecurityDto)
  security?: CiReportSecurityDto;
}

export class CiReportBodyDto {
  @IsString()
  repoFullName!: string;

  @IsString()
  branch!: string;

  @IsString()
  commitSha!: string;

  @IsNumber()
  @Min(0)
  runId!: number;

  @IsIn(['access', 'quality', 'package'])
  stage!: 'access' | 'quality' | 'package';

  @IsIn(['success', 'failure', 'cancelled'])
  conclusion!: 'success' | 'failure' | 'cancelled';

  @IsObject()
  @ValidateNested()
  @Type(() => CiReportResultsDto)
  results!: CiReportResultsDto;

  /** Raw log output captured during the stage. Capped at 50 000 chars on ingest. */
  @IsOptional()
  @IsString()
  rawLogs?: string;
}
