import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListCatalogQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsIn(['nextjs', 'react', 'react-native', 'expo', 'nestjs', 'nodejs'])
  stack?: 'nextjs' | 'react' | 'react-native' | 'expo' | 'nestjs' | 'nodejs';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}
