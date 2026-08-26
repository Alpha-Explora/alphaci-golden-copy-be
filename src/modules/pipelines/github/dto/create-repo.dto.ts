import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRepoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  repoName: string = '';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsBoolean()
  private: boolean = true;
}
