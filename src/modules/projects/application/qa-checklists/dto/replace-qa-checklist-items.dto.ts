import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  Min,
  ValidateNested,
} from 'class-validator';

import { QA_CHECKLIST_MAX_ITEMS } from '../qa-checklists.contracts';
import { QaChecklistItemDto } from './qa-checklist-item.dto';

export class ReplaceQaChecklistItemsDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsArray()
  @ArrayMaxSize(QA_CHECKLIST_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => QaChecklistItemDto)
  items!: QaChecklistItemDto[];
}
