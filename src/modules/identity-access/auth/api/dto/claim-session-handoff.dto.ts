import { IsString, Length } from 'class-validator';

export class ClaimSessionHandoffDto {
  @IsString()
  @Length(8, 256)
  token!: string;
}
