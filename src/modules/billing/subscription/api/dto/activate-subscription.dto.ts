import { IsIn, IsOptional } from 'class-validator';

export class ActivateSubscriptionDto {
  @IsOptional()
  @IsIn(['pro'])
  plan?: 'pro';
}
