import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** PATCH a test case. `null` clears expectedResult; omitted leaves it. */
export class UpdateTestCaseDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  expectedResult?: string | null;
}
