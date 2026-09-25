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

import { QA_CHECKLIST_MAX_ITEMS } from '../qa-checklists.contracts';
import { QaChecklistItemDto } from './qa-checklist-item.dto';

export class CreateQaChecklistDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(QA_CHECKLIST_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => QaChecklistItemDto)
  items?: QaChecklistItemDto[];
}
