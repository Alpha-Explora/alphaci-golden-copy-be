import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

const ACTIVITY_TYPES = [
  'assignment',
  'configuration',
  'membership',
  'github',
] as const;

export class QueryActivityDto {
  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  systemId?: string;

  @IsOptional()
  @IsString()
  deliveryProjectId?: string;

  @IsOptional()
  @IsString()
  repositoryId?: string;

  @IsOptional()
  @IsIn(ACTIVITY_TYPES)
  activityType?: (typeof ACTIVITY_TYPES)[number];

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  dateTo?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
