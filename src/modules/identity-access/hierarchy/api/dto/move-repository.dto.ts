import { IsUUID } from 'class-validator';

export class MoveRepositoryDto {
  @IsUUID()
  deliveryProjectId!: string;
}
