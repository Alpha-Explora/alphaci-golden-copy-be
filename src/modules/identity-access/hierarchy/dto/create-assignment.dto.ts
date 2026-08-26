import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateAssignmentDto {
  @IsString()
  @MinLength(1)
  userId: string = '';

  // Only 'write' exists this session (plan §2.6, §6 open question #3) — the
  // field exists for future extension, not selectable by callers yet.
  @IsOptional()
  @IsIn(['write'])
  accessLevel?: 'write';
}
