import { IsEmail, IsString, Length, MaxLength, Matches } from 'class-validator';

export class CheckEmailAvailabilityDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class EmailSignupDto {
  @IsString()
  @Length(1, 80)
  firstName!: string;

  @IsString()
  @Length(1, 80)
  lastName!: string;

  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @Length(8, 128)
  password!: string;
}

export class EmailLoginDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @Length(8, 128)
  password!: string;
}

export class VerifyEmailCodeDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class ResendEmailCodeDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
