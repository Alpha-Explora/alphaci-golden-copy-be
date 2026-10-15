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
import type { AssignmentRequestConfig } from '#kernel/ports/onprem-assignment.port';
class InitialHostAssignmentDto {
  /** Omitted when the workspace has a single healthy machine. */
  @IsOptional() @IsUUID() machineId?: string;
  @IsUUID() requestId!: string;
  @IsObject() config!: AssignmentRequestConfig;
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
}

/** An environment defined during project creation, which may also pick its host. */
export class CreateProjectEnvironmentDto extends AddProjectEnvironmentDto {
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
