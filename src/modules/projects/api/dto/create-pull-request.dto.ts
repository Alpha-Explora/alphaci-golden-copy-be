import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * A git branch name, as far as it can be checked without asking GitHub.
 *
 * Rejects what git itself refuses (whitespace, `..`, `~^:?*[\`, a leading dash)
 * so a malformed name is a 400 here rather than a GitHub 422 that has to be
 * translated back into "that is not a branch name".
 */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[^\s~^:?*[\\]+$/;
const BRANCH_MESSAGE = 'must be a valid branch name';

/** What the compose screen sends to open a pull request. */
export class CreatePullRequestDto {
  @IsString()
  @MaxLength(255)
  @Matches(BRANCH_NAME, { message: `base ${BRANCH_MESSAGE}` })
  base!: string;

  @IsString()
  @MaxLength(255)
  @Matches(BRANCH_NAME, { message: `head ${BRANCH_MESSAGE}` })
  head!: string;

  // GitHub's own limit on a pull request title.
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  title!: string;

  // GitHub's own limit on a pull request body.
  @IsOptional()
  @IsString()
  @MaxLength(65_536)
  body?: string;

  @IsOptional()
  @IsBoolean()
  draft?: boolean;
}
