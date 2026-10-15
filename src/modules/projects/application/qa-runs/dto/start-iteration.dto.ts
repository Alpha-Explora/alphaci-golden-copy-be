import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Most items one start can carry over; bounds the payload. */
export const ITERATION_CARRY_MAX_ITEMS = 2000;

export class CarryOverDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ITERATION_CARRY_MAX_ITEMS)
  @IsString({ each: true })
  requirementItemIds?: string[];
}

export class StartIterationDto {
  /**
   * Trimmed in the service; an empty goal is stored as null and one over 120
   * characters answers 400 ITERATION_GOAL_INVALID. The cap here only bounds
   * the payload.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  goal?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CarryOverDto)
  carryOver?: CarryOverDto;
}
