import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ValidateNested } from 'class-validator';

import { QA_REQUIREMENT_MAX_ITEMS } from '../qa-requirements.contracts';
import { RequirementItemDto } from './requirement-item.dto';

/** A requirement without its kind: the part shared by the single and batch create. */
export class RequirementDraftDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(QA_REQUIREMENT_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => RequirementItemDto)
  items?: RequirementItemDto[];
}

export class CreateRequirementDto extends RequirementDraftDto {
  /** 'functional' | 'system'; checked in the service so a bad value answers 400 REQUIREMENT_KIND_INVALID. */
  @IsString()
  kind!: string;
}
