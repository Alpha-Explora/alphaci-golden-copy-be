import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

import { QA_REQUIREMENT_MAX_ITEMS } from '../qa-requirements.contracts';

export class ReorderRequirementItemsDto {
  @IsArray()
  @ArrayMaxSize(QA_REQUIREMENT_MAX_ITEMS)
  @IsUUID('4', { each: true })
  itemIds!: string[];
}
