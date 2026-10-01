import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { QA_REQUIREMENT_MAX_ITEMS } from '../qa-requirements.contracts';
import { RequirementItemDto } from './requirement-item.dto';

export class CreateRequirementDto {
  /** 'functional' | 'system'; checked in the service so a bad value answers 400 REQUIREMENT_KIND_INVALID. */
  @IsString()
  kind!: string;

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
