import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { PIPELINE_BRANCHES } from '#kernel/config/pipeline-branches';

/** What a generated pipeline sends when it asks for a release. */
export class StartReleaseDto {
  @IsString()
  @Matches(/^[\w.-]+\/[\w.-]+$/, {
    message: 'repoFullName must be owner/repo',
  })
  repoFullName!: string;

  @IsIn(['backend', 'frontend', 'standalone'])
  slot!: string;

  // The branch the run belongs to, taken from pipeline-context rather than the
  // git context: a workflow_run chain reports the default branch.
  @IsIn(PIPELINE_BRANCHES)
  branch!: string;

  @IsString()
  @Matches(/^[0-9a-f]{7,40}$/i, {
    message: 'commitSha must be a git commit sha',
  })
  commitSha!: string;

  /** What the pipeline built, e.g. an image reference. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  artifact?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  runUrl?: string;
}
