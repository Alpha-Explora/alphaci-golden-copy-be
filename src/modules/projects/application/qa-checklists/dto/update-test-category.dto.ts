import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

/** PATCH (rename) a test case category. */
export class UpdateTestCategoryDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}
