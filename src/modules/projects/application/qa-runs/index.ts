export { QaRunsModule } from './qa-runs.module';
export { QaRunsService, type QaRunActorContext } from './qa-runs.service';
export { QaCommitResolutionService } from './qa-commit-resolution.service';
export { QaReportService } from './qa-report.service';
export { buildQaReportFilename } from './qa-report.filename';
export { renderQaReportMarkdown } from './qa-report.markdown';
export {
  buildQaReport,
  buildQaReportDefects,
  buildQaReportSummary,
  toSignoffHistoryEntry,
  type BuildQaReportInput,
} from './qa-report.mapper';
export {
  QA_REPORT_FORMATS,
  QA_REPORT_SCHEMA_VERSION,
  type QaReport,
  type QaReportDefect,
  type QaReportDefectStatus,
  type QaReportFormat,
  type QaReportProject,
  type QaReportSignoffHistoryEntry,
  type QaReportSummary,
} from './qa-report.contracts';
export type {
  QaActor,
  QaCommitSource,
  QaDefectSeverity,
  QaReturnedItem,
  QaRun,
  QaRunItem,
  QaRunItemFixRequest,
  QaRunItemPrevious,
  QaRunItemStatus,
  QaRunListItem,
  QaRunPermissions,
  QaRunStatus,
  QaRunSummaryCounts,
  QaSignoff,
  QaVerdict,
} from './qa-runs.contracts';
export {
  QA_DEFECT_SEVERITIES,
  QA_OPEN_DEFECT_STATUSES,
  QA_RUNS_LIST_DEFAULT_LIMIT,
  QA_RUNS_LIST_MAX_LIMIT,
  QA_RUN_ITEM_STATUSES,
  QA_VERDICTS,
} from './qa-runs.contracts';
