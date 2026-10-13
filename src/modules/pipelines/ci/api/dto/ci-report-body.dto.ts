import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { STAGE_ORDER, type StageId } from '../../application/stages';

// ─── Nested detail DTOs ───────────────────────────────────────────────────────

export class CiReportTestFailureDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  message?: string;
}

export class CiReportLintIssueDto {
  @IsOptional()
  @IsString()
  rule?: string;

  @IsOptional()
  @IsString()
  file?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  line?: number;

  @IsOptional()
  @IsString()
  message?: string;
}

export class CiReportSecurityItemDto {
  @IsOptional()
  @IsString()
  package?: string;

  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  severity?: string;
}

/** One top-level `test.step` of a browser test. */
export class CiReportTestCaseStepDto {
  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;

  @IsOptional()
  @IsBoolean()
  failed?: boolean;
}

/** An annotation a test wrote besides its description, e.g. "12 links checked". */
export class CiReportTestCaseNoteDto {
  @IsString()
  @MaxLength(40)
  type!: string;

  @IsString()
  @MaxLength(1000)
  text!: string;
}

export class CiReportTestCaseErrorDto {
  @IsString()
  @MaxLength(4000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  location?: string;
}

/**
 * One browser test as it ran: what it is, what it checks, what it did and how
 * it ended. Every field but the title and status is optional, and the limits
 * match what the reporting workflow trims to.
 */
export class CiReportTestCaseDto {
  @IsString()
  @MaxLength(500)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  file?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  line?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  project?: string;

  @IsIn(['passed', 'failed', 'flaky', 'skipped'])
  status!: 'passed' | 'failed' | 'flaky' | 'skipped';

  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  retries?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CiReportTestCaseNoteDto)
  notes?: CiReportTestCaseNoteDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CiReportTestCaseStepDto)
  steps?: CiReportTestCaseStepDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportTestCaseErrorDto)
  error?: CiReportTestCaseErrorDto;
}

// ─── Top-level result section DTOs ───────────────────────────────────────────

export class CiReportTestResultsDto {
  @IsInt()
  @Min(0)
  passed!: number;

  @IsInt()
  @Min(0)
  failed!: number;

  @IsInt()
  @Min(0)
  total!: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CiReportTestFailureDto)
  failures?: CiReportTestFailureDto[];

  /**
   * Full titles of the tests that PASSED, " > "-joined:
   * "<spec file> > <describe...> > <test>" (the same shape as a failure's
   * `name`).
   *
   * Optional because a pipeline generated before it existed does not send it,
   * and `forbidNonWhitelisted` would otherwise turn the new field into a 400
   * for every report. ABSENT means "this pipeline does not say which tests
   * passed" - QA matching then falls back to inference and marks it so - while
   * an empty array is a real answer: "ran, nothing passed". Capped at 500
   * names of at most 500 characters (the workflow trims to the same limits).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  passes?: string[];

  /**
   * Every test with its detail (see CiReportTestCaseDto), failures first.
   * Optional for the same reason as `passes`: a pipeline generated before it
   * existed does not send it, and `forbidNonWhitelisted` would otherwise
   * reject every such report. Capped at 50, as stored lists are.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CiReportTestCaseDto)
  cases?: CiReportTestCaseDto[];
}

export class CiReportCoverageDto {
  @IsNumber()
  @Min(0)
  pct!: number;

  @IsNumber()
  @Min(0)
  threshold!: number;
}

export class CiReportLintDto {
  @IsInt()
  @Min(0)
  errors!: number;

  @IsInt()
  @Min(0)
  warnings!: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CiReportLintIssueDto)
  issues?: CiReportLintIssueDto[];
}

export class CiReportSecurityDto {
  @IsInt()
  @Min(0)
  high!: number;

  @IsInt()
  @Min(0)
  critical!: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CiReportSecurityItemDto)
  items?: CiReportSecurityItemDto[];
}

/**
 * Counts from gates that can pass while still having found something.
 *
 * On dev these gates are advisory, so the job concludes `success` whether it
 * found nothing or found nine. The count is the only thing that separates the
 * two, and it is what lets the product say "passed, 3 secrets found — not
 * blocking here, will block at uat" instead of a bare green tick.
 */
/**
 * One committed secret, named by rule and location.
 *
 * There is no value field and there must never be one. gitleaks redacts the
 * log and the workflow selects three fields, so nothing downstream can store or
 * render the secret itself — a report carrying it would leak it a second time,
 * into a database and a web page more people can read than the repository.
 */
export class CiReportSecretItemDto {
  @IsOptional()
  @IsString()
  rule?: string;

  @IsOptional()
  @IsString()
  file?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  line?: number;
}

/** One package whose licence the policy forbids. */
export class CiReportLicenseItemDto {
  @IsOptional()
  @IsString()
  package?: string;

  @IsOptional()
  @IsString()
  version?: string;

  @IsOptional()
  @IsString()
  license?: string;
}

export class CiReportFindingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  secrets?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  forbiddenLicenses?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sbomComponents?: number;

  /**
   * Packages whose licence could not be determined.
   *
   * Deliberately separate from `forbiddenLicenses`: "this one is disallowed"
   * and "we could not tell" need different responses, and merging them either
   * buries a real hit or invents one.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  undeterminedLicenses?: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CiReportSecretItemDto)
  secretItems?: CiReportSecretItemDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CiReportLicenseItemDto)
  licenseItems?: CiReportLicenseItemDto[];
}

/** One quality-gate condition SonarCloud failed, with the numbers behind it. */
export class CiReportSonarConditionDto {
  @IsString()
  metric!: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  actual?: string;

  @IsOptional()
  @IsString()
  threshold?: string;
}

/** One SonarCloud issue on new code: the rule, where, and what it says. */
export class CiReportSonarIssueDto {
  @IsString()
  @MaxLength(200)
  rule!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  severity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  type?: string;

  @IsString()
  @MaxLength(1000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  file?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  line?: number;
}

/**
 * What SonarCloud reported, rather than only whether it passed.
 *
 * `gate` can be UNKNOWN, which is kept rather than dropped: it means the
 * analysis ran and the gate could not be read. That is a different thing from
 * a gate that passed, and treating it as clean is how a broken reporting path
 * starts to look like a healthy project.
 */
export class CiReportSonarDto {
  @IsOptional()
  @IsString()
  gate?: string;

  /**
   * Why the analysis could not run, when the cause is a setting rather than
   * the code. Carried as a field because it cannot arrive as an annotation:
   * a workflow-level error is attributed to `.github`, and those are filtered.
   */
  @IsOptional()
  @IsString()
  blockedBy?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CiReportSonarConditionDto)
  failedConditions?: CiReportSonarConditionDto[];

  /**
   * Bugs, vulnerabilities, code smells, hotspots, coverage, duplication.
   *
   * Left as an open string map because the metric keys are SonarCloud's, and
   * pinning them here would mean a metric added upstream is rejected by
   * `forbidNonWhitelisted` rather than shown.
   */
  @IsOptional()
  @IsObject()
  measures?: Record<string, string>;

  /**
   * The most severe issues on new code, at most 20, so a developer sees the
   * file and line to fix rather than a count. Optional: older pipelines and
   * the .NET scan before it was updated do not send them.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CiReportSonarIssueDto)
  issues?: CiReportSonarIssueDto[];
}

/**
 * Why a stage left its work out on purpose, such as verify with nothing
 * deployed. Reported as a success so no database constraint has to change, and
 * read back as a stage that did not run, with this as the reason.
 */
export class CiReportSkippedDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class CiReportResultsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportTestResultsDto)
  tests?: CiReportTestResultsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportSkippedDto)
  skipped?: CiReportSkippedDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportCoverageDto)
  coverage?: CiReportCoverageDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportLintDto)
  lint?: CiReportLintDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportSecurityDto)
  security?: CiReportSecurityDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportFindingsDto)
  findings?: CiReportFindingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CiReportSonarDto)
  sonar?: CiReportSonarDto;
}

/**
 * One error GitHub recorded against a failed job, with its location.
 *
 * Annotations are what a linter, compiler or test runner reports through the
 * Checks API — the file, the line and the message. They are the difference
 * between "the quality stage failed" and "src/app.ts:42 no-unused-vars".
 */
export class CiReportAnnotationDto {
  @IsOptional()
  @IsString()
  path?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  line?: number;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  message?: string;

  /**
   * GitHub's own severity: 'failure', 'warning' or 'notice'.
   *
   * Carried because the same diagnostic means different things per branch. On
   * dev a formatter reports warnings and the job still passes; on uat that
   * identical annotation is what fails the build. Without the level the reader
   * cannot tell a blocking error from advice.
   */
  @IsOptional()
  @IsString()
  level?: string;
}

/**
 * One tool's outcome inside a stage.
 *
 * A stage status answers "did quality pass". It cannot answer "did the licence
 * scan pass", and one bar covering seven tools is what sent people to GitHub to
 * find out which of them was red.
 */
export class CiReportCheckDto {
  @IsString()
  name!: string;

  @IsString()
  conclusion!: string;

  @IsOptional()
  @IsString()
  startedAt?: string;

  @IsOptional()
  @IsString()
  completedAt?: string;
}

export class CiReportBodyDto {
  @IsString()
  repoFullName!: string;

  @IsString()
  branch!: string;

  @IsString()
  commitSha!: string;

  @IsNumber()
  @Min(0)
  runId!: number;

  @IsIn([...STAGE_ORDER])
  stage!: StageId;

  @IsIn(['success', 'failure', 'cancelled'])
  conclusion!: 'success' | 'failure' | 'cancelled';

  @IsObject()
  @ValidateNested()
  @Type(() => CiReportResultsDto)
  results!: CiReportResultsDto;

  /** Raw log output captured during the stage. Capped at 50 000 chars on ingest. */
  @IsOptional()
  @IsString()
  rawLogs?: string;

  /**
   * The individual errors behind the failure, from the GitHub Checks API.
   *
   * Optional because a pipeline generated before this existed does not send
   * them, and an older workflow must keep reporting rather than start failing
   * validation.
   */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CiReportAnnotationDto)
  annotations?: CiReportAnnotationDto[];

  /**
   * Every job in the stage and what it concluded, so the product can show a
   * row per tool rather than one status for all of them.
   *
   * Optional for the same reason as `annotations`: a pipeline generated before
   * this field existed does not send it. That matters more than it looks —
   * `forbidNonWhitelisted` is on, so an undeclared property does not get
   * stripped, it rejects the whole report with a 400. A field added to the
   * pipeline before it is declared here silently stops every run reporting.
   */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CiReportCheckDto)
  checks?: CiReportCheckDto[];
}
