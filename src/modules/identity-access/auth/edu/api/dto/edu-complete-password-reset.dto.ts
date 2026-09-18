import { IsString, MinLength } from 'class-validator';

export class EduCompletePasswordResetDto {
  @IsString()
  accessToken!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
