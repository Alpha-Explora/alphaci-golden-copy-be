import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateRepositoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string = '';

  // Private only — enforced, not just defaulted (plan §2.6).
  @IsIn(['private'])
  visibility = 'private' as const;
}
