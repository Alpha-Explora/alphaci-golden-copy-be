import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import type { QaChecklistVerificationType } from '../qa-checklists.contracts';

const VERIFICATION_TYPES: QaChecklistVerificationType[] = [
  'manual',
  'playwright',
  'unit_test',
  'bruno',
];

/** One User story (functional) or checklist item (system) in a requirement. */
export class RequirementItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

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
