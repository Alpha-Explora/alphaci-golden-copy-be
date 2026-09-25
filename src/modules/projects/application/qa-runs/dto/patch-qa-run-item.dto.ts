import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import {
  QA_DEFECT_SEVERITIES,
  QA_RUN_ITEM_STATUSES,
  type QaDefectSeverity,
  type QaRunItemStatus,
} from '../qa-runs.contracts';

/**
 * PATCH body for one run item. Every field besides `expectedRowVersion` is
 * optional and independently "not provided" (omitted) vs "explicitly null"
 * (clear it) for notes/defectSeverity/reproductionSteps — `@IsOptional()`
 * treats both `undefined` and `null` as "skip further validation", the same
 * convention qa-checklist-item.dto.ts already relies on for its nullable
 * fields, so the service is the one place that must tell "omitted" and
 * "null" apart (via `!== undefined`) when building the SQL patch.
 */
export class PatchQaRunItemDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsOptional()
  @IsIn(QA_RUN_ITEM_STATUSES)
  status?: QaRunItemStatus;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string | null;

  @IsOptional()
  @IsIn(QA_DEFECT_SEVERITIES)
  defectSeverity?: QaDefectSeverity | null;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  reproductionSteps?: string | null;
}
