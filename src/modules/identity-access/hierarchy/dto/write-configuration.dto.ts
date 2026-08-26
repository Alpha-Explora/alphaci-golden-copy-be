import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

import type { EnvironmentScope } from '../hierarchy.types';

export class WriteConfigurationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(16_384)
  value: string = '';

  @IsIn(['non_production', 'production'])
  environmentScope: EnvironmentScope = 'non_production';
}
