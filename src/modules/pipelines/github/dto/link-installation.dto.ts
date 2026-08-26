import { IsInt, Min } from 'class-validator';

export class LinkInstallationDto {
  @IsInt()
  @Min(1)
  installationId!: number;
}
