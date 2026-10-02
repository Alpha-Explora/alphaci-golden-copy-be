import { Type } from 'class-transformer';
import { IsArray, IsString, ValidateNested } from 'class-validator';

import { RequirementDraftDto } from './create-requirement.dto';

/**
 * Up to QA_REQUIREMENT_BATCH_MAX requirements of one kind, created together.
 * The 1..20 bound is checked in the service so it answers the coded
 * 400 REQUIREMENT_BATCH_INVALID rather than a generic validation error.
 */
export class CreateRequirementsBatchDto {
  /** 'functional' | 'system'; checked in the service (400 REQUIREMENT_KIND_INVALID). */
  @IsString()
  kind!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RequirementDraftDto)
  requirements!: RequirementDraftDto[];
}
