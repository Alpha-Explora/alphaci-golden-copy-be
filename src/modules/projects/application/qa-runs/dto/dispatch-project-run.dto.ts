import { IsOptional, IsUUID } from 'class-validator';

/** Body of POST .../automation/dispatch: optionally narrow the dispatch to one covered repository. */
export class DispatchProjectRunDto {
  @IsOptional()
  @IsUUID('4')
  projectId?: string;
}
