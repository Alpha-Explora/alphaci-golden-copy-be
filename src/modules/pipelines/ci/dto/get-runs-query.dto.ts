import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class GetRunsQueryDto {
  @IsOptional()
  @IsString()
  repoFullName?: string;

  /** Maximum number of run-stage rows to return. Default: 150, max: 500. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  /** Number of run-stage rows to skip (for pagination). Default: 0. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
