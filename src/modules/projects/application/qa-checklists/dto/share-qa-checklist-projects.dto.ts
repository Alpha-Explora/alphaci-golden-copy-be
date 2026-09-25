import { IsArray, IsUUID } from 'class-validator';

export class ShareQaChecklistProjectsDto {
  @IsArray()
  @IsUUID('4', { each: true })
  projectIds!: string[];
}
