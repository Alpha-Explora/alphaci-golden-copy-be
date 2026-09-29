import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body for DELETE /api/v1/delivery-projects/:deliveryProjectId.
 *
 * `confirmName` must exactly match this delivery project's current name
 * (re-validated server-side in DeliveryProjectsService.deleteDeliveryProject,
 * never trusted from the client alone) — mirrors DisconnectProjectDto's
 * confirmRepoName, one level up: the human confirms the Project (folder)
 * name once, and every repository inside it is torn down without asking
 * again per-repository.
 *
 * The three opt-ins are forwarded to disconnectProject for every linked
 * repository, exactly like DisconnectProjectDto's own opt-ins. Destructive
 * opt-ins remain owner/delegated_lead-only, enforced independently inside
 * disconnectProject itself (both by its app-layer pre-check and, as the
 * fail-closed layer, the SQL predicate its repository methods apply) — this
 * DTO does not re-derive that role restriction.
 */
export class DeleteDeliveryProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  confirmName!: string;

  @IsOptional()
  @IsBoolean()
  deleteGithubRepos?: boolean;

  @IsOptional()
  @IsBoolean()
  deleteProviderResources?: boolean;

  @IsOptional()
  @IsBoolean()
  deleteSonarProjects?: boolean;
}
