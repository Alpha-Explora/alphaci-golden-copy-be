import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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

export class RenameProjectEnvironmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;
}
