import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Body for DELETE /api/v1/projects/:id.
 *
 * Default (deleteGithubRepo omitted or false): unchanged plain DB-only
 * disconnect — the GitHub repository, workflows, and secrets are untouched.
 *
 * Opt-in (deleteGithubRepo: true): also attempts to delete the GitHub
 * repository. Requires confirmRepoName to exactly match the project's
 * repo_full_name (e.g. "my-org/my-repo", the same string shown in the FE
 * confirmation dialog) — this is re-validated server-side in
 * ProjectsService.disconnectProject and is NOT trusted from the client
 * alone. A mismatch throws BadRequestException before any GitHub call is
 * made.
 */
export class DisconnectProjectDto {
  @IsOptional()
  @IsBoolean()
  deleteGithubRepo?: boolean;

  @ValidateIf((dto: DisconnectProjectDto) => dto.deleteGithubRepo === true)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  confirmRepoName?: string;
}
