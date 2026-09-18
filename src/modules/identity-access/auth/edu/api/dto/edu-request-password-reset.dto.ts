import { IsEmail } from 'class-validator';

export class EduRequestPasswordResetDto {
  @IsEmail()
  email!: string;
}
