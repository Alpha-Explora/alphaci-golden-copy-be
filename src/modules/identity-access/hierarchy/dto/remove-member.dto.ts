import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RemoveMemberDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
