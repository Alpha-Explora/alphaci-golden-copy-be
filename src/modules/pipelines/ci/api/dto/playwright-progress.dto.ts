import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import {
  PLAYWRIGHT_LIVE_EVENT_TYPES,
  PLAYWRIGHT_LIVE_MAX_EVENTS_PER_BATCH,
  PLAYWRIGHT_LIVE_RUN_FINISH_STATUSES,
  PLAYWRIGHT_LIVE_TEST_STATUSES,
} from '../../application/playwright-live.rules';

/**
 * Wire shape of POST /ci/playwright-progress. As with every CI DTO the global
 * ValidationPipe runs with forbidNonWhitelisted, so an undeclared field on the
 * envelope, an event, a test or the summary rejects the whole batch (400).
 * The event union is discriminated on `type`; an unknown type falls back to
 * the base class, whose `type` check fails.
 */

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SHA_PATTERN = /^[0-9a-fA-F]{7,64}$/;

export class PlaywrightEventBaseDto {
  @IsIn(PLAYWRIGHT_LIVE_EVENT_TYPES)
  type!: (typeof PLAYWRIGHT_LIVE_EVENT_TYPES)[number];

  @IsISO8601({ strict: true })
  at!: string;
}

export class PlaywrightRunStartedEventDto extends PlaywrightEventBaseDto {
  // Narrows the base class's union so the event union discriminates on `type`.
  declare type: 'run_started';

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  total!: number;
}

export class PlaywrightTestIdentityDto {
  @IsString()
  @Length(1, 300)
  id!: string;

  @IsString()
  @MaxLength(300)
  file!: string;

  @IsString()
  @MaxLength(300)
  title!: string;

  @IsString()
  @Length(1, 100)
  project!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  retry?: number;
}

export class PlaywrightFinishedTestDto extends PlaywrightTestIdentityDto {
  @IsIn(PLAYWRIGHT_LIVE_TEST_STATUSES)
  status!: (typeof PLAYWRIGHT_LIVE_TEST_STATUSES)[number];

  @IsInt()
  @Min(0)
  @Max(86_400_000)
  durationMs!: number;

  /** Optional and nullable: a passing test has no error. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  error?: string | null;
}

export class PlaywrightTestStartedEventDto extends PlaywrightEventBaseDto {
  // Narrows the base class's union so the event union discriminates on `type`.
  declare type: 'test_started';

  @IsDefined()
  @ValidateNested()
  @Type(() => PlaywrightTestIdentityDto)
  test!: PlaywrightTestIdentityDto;
}

export class PlaywrightTestFinishedEventDto extends PlaywrightEventBaseDto {
  // Narrows the base class's union so the event union discriminates on `type`.
  declare type: 'test_finished';

  @IsDefined()
  @ValidateNested()
  @Type(() => PlaywrightFinishedTestDto)
  test!: PlaywrightFinishedTestDto;
}

export class PlaywrightRunSummaryDto {
  @IsInt()
  @Min(0)
  passed!: number;

  @IsInt()
  @Min(0)
  failed!: number;

  @IsInt()
  @Min(0)
  skipped!: number;

  @IsInt()
  @Min(0)
  flaky!: number;

  @IsInt()
  @Min(0)
  durationMs!: number;
}

export class PlaywrightRunFinishedEventDto extends PlaywrightEventBaseDto {
  // Narrows the base class's union so the event union discriminates on `type`.
  declare type: 'run_finished';

  @IsIn(PLAYWRIGHT_LIVE_RUN_FINISH_STATUSES)
  status!: (typeof PLAYWRIGHT_LIVE_RUN_FINISH_STATUSES)[number];

  @IsDefined()
  @ValidateNested()
  @Type(() => PlaywrightRunSummaryDto)
  summary!: PlaywrightRunSummaryDto;
}

export type PlaywrightProgressEventDto =
  | PlaywrightRunStartedEventDto
  | PlaywrightTestStartedEventDto
  | PlaywrightTestFinishedEventDto
  | PlaywrightRunFinishedEventDto;

export class PlaywrightProgressBodyDto {
  @IsString()
  @Length(3, 200)
  @Matches(REPO_PATTERN, { message: 'repoFullName must be owner/repo' })
  repoFullName!: string;

  @IsString()
  @Length(1, 200)
  @Matches(BRANCH_PATTERN, {
    message: 'branch contains unsupported characters',
  })
  branch!: string;

  @IsInt()
  @Min(1)
  runId!: number;

  @IsInt()
  @Min(1)
  runAttempt!: number;

  @IsString()
  @Matches(SHA_PATTERN, { message: 'commitSha must be a hex commit id' })
  commitSha!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PLAYWRIGHT_LIVE_MAX_EVENTS_PER_BATCH)
  @ValidateNested({ each: true })
  @Type(() => PlaywrightEventBaseDto, {
    keepDiscriminatorProperty: true,
    discriminator: {
      property: 'type',
      subTypes: [
        { value: PlaywrightRunStartedEventDto, name: 'run_started' },
        { value: PlaywrightTestStartedEventDto, name: 'test_started' },
        { value: PlaywrightTestFinishedEventDto, name: 'test_finished' },
        { value: PlaywrightRunFinishedEventDto, name: 'run_finished' },
      ],
    },
  })
  events!: PlaywrightProgressEventDto[];
}
