import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import {
  VISUAL_BROWSER_PATTERN,
  VISUAL_MAX_SNAPSHOTS_PER_RUN,
  VISUAL_NAME_PATTERN,
} from '../../application/visual-regression.rules';

/**
 * Wire shapes of the three token-authenticated visual-testing calls the
 * generated Playwright job makes. Same strictness as the report DTO (the
 * global ValidationPipe runs with forbidNonWhitelisted, so an undeclared field
 * rejects the whole request), plus character-set limits on everything that
 * becomes a storage key.
 */

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SHA_PATTERN = /^[0-9a-fA-F]{7,64}$/;
const NAME_MESSAGE =
  'name must be a safe .png file name (letters, digits, ".", "_", "-"; at most 120 characters)';

export class VisualBaselinesQueryDto {
  @IsString()
  @Length(3, 200)
  @Matches(REPO_PATTERN, { message: 'repoFullName must be owner/repo' })
  repoFullName!: string;

  @IsString()
  @Length(1, 200)
  @Matches(BRANCH_PATTERN, {
    message: 'branch contains unsupported characters',
  })
  branch!: string;
}

export class VisualBaselineFileQueryDto extends VisualBaselinesQueryDto {
  @IsString()
  @Matches(VISUAL_NAME_PATTERN, { message: NAME_MESSAGE })
  name!: string;
}

export class VisualSummarySnapshotDto {
  @IsString()
  @Matches(VISUAL_NAME_PATTERN, { message: NAME_MESSAGE })
  name!: string;

  @IsIn(['passed', 'changed', 'new'])
  status!: 'passed' | 'changed' | 'new';
}

export class VisualSummaryBodyDto {
  @IsString()
  @Length(3, 200)
  @Matches(REPO_PATTERN, { message: 'repoFullName must be owner/repo' })
  repoFullName!: string;

  @IsString()
  @Length(1, 200)
  @Matches(BRANCH_PATTERN, {
    message: 'branch contains unsupported characters',
  })
  branch!: string;

  @IsString()
  @Matches(SHA_PATTERN, { message: 'commitSha must be a hex commit id' })
  commitSha!: string;

  @IsInt()
  @Min(0)
  runId!: number;

  @IsInt()
  @Min(1)
  runAttempt!: number;

  @IsString()
  @Matches(VISUAL_BROWSER_PATTERN, {
    message: 'browser must be lower-case letters, digits, "_" or "-"',
  })
  browser!: string;

  @IsArray()
  @ArrayMaxSize(VISUAL_MAX_SNAPSHOTS_PER_RUN)
  @ValidateNested({ each: true })
  @Type(() => VisualSummarySnapshotDto)
  snapshots!: VisualSummarySnapshotDto[];
}

/**
 * The text fields of the multipart upload. Multipart values are all strings,
 * so the run id arrives as digits and is parsed by the service.
 */
export class VisualResultFileFieldsDto {
  @IsString()
  @Length(3, 200)
  @Matches(REPO_PATTERN, { message: 'repoFullName must be owner/repo' })
  repoFullName!: string;

  @IsString()
  @Length(1, 200)
  @Matches(BRANCH_PATTERN, {
    message: 'branch contains unsupported characters',
  })
  branch!: string;

  @IsString()
  @Matches(SHA_PATTERN, { message: 'commitSha must be a hex commit id' })
  commitSha!: string;

  @IsString()
  @Matches(/^\d{1,15}$/, { message: 'runId must be a positive integer' })
  runId!: string;

  @IsString()
  @Matches(VISUAL_BROWSER_PATTERN, {
    message: 'browser must be lower-case letters, digits, "_" or "-"',
  })
  browser!: string;

  @IsString()
  @Matches(VISUAL_NAME_PATTERN, { message: NAME_MESSAGE })
  name!: string;

  @IsIn(['actual', 'diff'])
  kind!: 'actual' | 'diff';
}
