import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Which pipeline execution to export: a repository, a branch and a commit. */
export class GetRunReportQueryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, {
    message: 'repoFullName must be "owner/repo".',
  })
  repoFullName!: string;

  @IsString()
  @MaxLength(255)
  branch!: string;

  /** The full commit SHA the run covered. */
  @IsString()
  @Matches(/^[0-9a-fA-F]{7,64}$/, { message: 'commitSha must be a hex SHA.' })
  commitSha!: string;

  /** `json` (default) or `md`; `markdown` is accepted as an alias. */
  @IsOptional()
  @IsIn(['json', 'md', 'markdown'])
  format?: 'json' | 'md' | 'markdown';
}
