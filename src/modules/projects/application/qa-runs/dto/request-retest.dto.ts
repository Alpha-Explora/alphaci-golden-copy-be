import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestRetestDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}
