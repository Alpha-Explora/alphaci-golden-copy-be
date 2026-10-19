import { IsString, MaxLength, MinLength } from 'class-validator';

/** POST a test case category under a User story. */
export class CreateTestCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}
