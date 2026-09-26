import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from 'class-validator';

/**
 * PATCH /qa-checklists/:id/projects: attach or detach some projects without
 * touching any other share. The PUT variant replaces the whole set, which a
 * view scoped to one project folder must never do.
 */
export class UpdateQaChecklistProjectsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  add?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  remove?: string[];
}
