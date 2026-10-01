import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * POST /groups/:groupId/projects — creates a system + delivery project with
 * NO repository, so a team can group future repos under a named "Project
 * folder" before any of them exist. Same shape as CreateSystemDto /
 * CreateDeliveryProjectDto (both are "name a hierarchy node"); a dedicated
 * class keeps this endpoint's request self-documenting.
 */
export class CreateEmptyProjectDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string = '';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
