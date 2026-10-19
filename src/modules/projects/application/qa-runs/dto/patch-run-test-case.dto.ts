import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import {
  QA_TEST_CASE_STATUSES,
  type QaTestCaseStatus,
} from '../qa-runs.contracts';

/** PATCH one test case's result in a Project run. `null` clears notes; omitted leaves them. */
export class PatchRunTestCaseDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsOptional()
  @IsIn(QA_TEST_CASE_STATUSES)
  status?: QaTestCaseStatus;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}
