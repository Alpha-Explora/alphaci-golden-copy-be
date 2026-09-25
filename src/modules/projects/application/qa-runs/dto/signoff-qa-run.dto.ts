import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { QA_VERDICTS, type QaVerdict } from '../qa-runs.contracts';

export class SignoffQaRunDto {
  @IsIn(QA_VERDICTS)
  verdict!: QaVerdict;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  conditions?: string | null;
}
