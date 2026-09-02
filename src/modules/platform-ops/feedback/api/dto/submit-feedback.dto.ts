import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import type { FeedbackCategory } from '../../application/feedback.types';

export class SubmitFeedbackDto {
  @IsOptional()
  @IsIn(['general', 'bug', 'feature_request', 'billing', 'other'])
  category?: FeedbackCategory;

  @IsString()
  @MinLength(3)
  @MaxLength(160)
  subject!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  body!: string;
}
