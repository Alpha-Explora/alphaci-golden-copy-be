import { IsOptional, IsString, Matches } from 'class-validator';

export class DiscoverExistingRepoDto {
  @IsString()
  @Matches(/^[^/\s]+\/[^/\s]+$/)
  repoFullName!: string;

  @IsOptional()
  @IsString()
  baseBranch?: string;
}
