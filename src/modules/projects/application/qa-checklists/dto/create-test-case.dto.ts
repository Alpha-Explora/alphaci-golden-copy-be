import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** POST a test case into a category. */
export class CreateTestCaseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  expectedResult?: string | null;
}
