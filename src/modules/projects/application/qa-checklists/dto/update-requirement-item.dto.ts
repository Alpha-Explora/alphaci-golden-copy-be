import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type { QaChecklistVerificationType } from '../qa-checklists.contracts';

const VERIFICATION_TYPES: QaChecklistVerificationType[] = [
  'manual',
  'playwright',
  'unit_test',
  'bruno',
];

/** PATCH one item's definition. `null` clears acceptanceCriteria / testIdentifier; omitted leaves them. */
export class UpdateRequirementItemDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  acceptanceCriteria?: string | null;

  @IsOptional()
  @IsIn(VERIFICATION_TYPES)
  verificationType?: QaChecklistVerificationType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  testIdentifier?: string | null;
}
