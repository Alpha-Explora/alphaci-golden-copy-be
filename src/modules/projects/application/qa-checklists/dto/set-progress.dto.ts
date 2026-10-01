import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import {
  QA_PROGRESS_VALUES,
  type QaProgress,
} from '../qa-requirements.contracts';

export class SetProgressDto {
  @IsIn(QA_PROGRESS_VALUES)
  progress!: QaProgress;

  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}
