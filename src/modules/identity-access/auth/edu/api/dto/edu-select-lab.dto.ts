import { IsUUID } from 'class-validator';

export class EduSelectLabDto {
  @IsUUID()
  orgId!: string;
}
