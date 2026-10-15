import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { AssignmentConfig } from '#kernel/ports/onprem-assignment.port';
class InitialHostAssignmentDto {
  @IsUUID() machineId!: string;
  @IsUUID() requestId!: string;
  @IsObject() config!: AssignmentConfig;
}

export class AddProjectEnvironmentDto {
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MaxLength(48)
  slug!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  sourceBranch!: string;

  @IsIn(['production', 'non_production'])
  role!: 'production' | 'non_production';
  @IsOptional()
  @ValidateNested()
  @Type(() => InitialHostAssignmentDto)
  hostAssignment?: InitialHostAssignmentDto;
}

export class RenameProjectEnvironmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;
}
