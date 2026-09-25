import { IsString, IsUUID, MinLength } from 'class-validator';

export class CreateQaRunDto {
  @IsUUID('4')
  checklistId!: string;

  @IsString()
  @MinLength(1)
  branch!: string;
}
