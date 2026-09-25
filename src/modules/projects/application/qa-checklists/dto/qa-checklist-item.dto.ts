import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import type {
  QaChecklistTargetPersona,
  QaChecklistVerificationType,
} from '../qa-checklists.contracts';

const TARGET_PERSONAS: QaChecklistTargetPersona[] = ['developer', 'qa', 'all'];
const VERIFICATION_TYPES: QaChecklistVerificationType[] = [
  'manual',
  'playwright',
  'unit_test',
  'bruno',
];

/** One item in a checklist's ordered item list. `position` is the array index. */
export class QaChecklistItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsIn(TARGET_PERSONAS)
  targetPersona!: QaChecklistTargetPersona;

  @IsIn(VERIFICATION_TYPES)
  verificationType!: QaChecklistVerificationType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  testIdentifier?: string | null;
}
