import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Min,
} from 'class-validator';

/** The same safe-basename shape ingestion enforces; anything else cannot be a stored snapshot. */
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,115}\.png$/;

/** What the Visual tab sends to approve changed or new snapshots as baselines. */
export class ApproveVisualBaselinesDto {
  @IsIn(['uat', 'main'])
  branch!: 'uat' | 'main';

  @IsInt()
  @Min(0)
  runId!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(SNAPSHOT_NAME, {
    each: true,
    message: 'each name must be a safe .png snapshot name',
  })
  names!: string[];
}
