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
  type QaDefectSeverity,
} from '../qa-runs.contracts';

/**
 * The Product owner's decision on one item of a signed-off Project run
 * (ADR-0014, amendment 12). `passed` accepts it; `failed` reopens the run and
 * returns the story to the Developers as Failed, so it needs notes saying why.
 */
export class AcceptQaRunItemDto {
  @IsIn(['passed', 'failed'])
  decision!: 'passed' | 'failed';

  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsIn(QA_DEFECT_SEVERITIES)
  defectSeverity?: QaDefectSeverity;
}
