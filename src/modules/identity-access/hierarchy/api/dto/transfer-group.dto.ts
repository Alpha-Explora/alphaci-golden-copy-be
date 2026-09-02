import { IsString, MinLength } from 'class-validator';

export class TransferGroupDto {
  @IsString()
  @MinLength(1)
  newManagerUserId: string = '';
}
