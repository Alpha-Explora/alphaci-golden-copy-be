import { Inject, Injectable } from '@nestjs/common';

import {
  CI_STAGE_RESULTS_LOOKUP,
  type CiStageResult,
  type CiStageResultsLookup,
} from '#kernel/ports/ci-stage-results.port';
import type { QaRunAutomation, QaStageAutomation } from './qa-runs.contracts';

function toStageAutomation(result: CiStageResult): QaStageAutomation {
  return {
    stage: result.stage,
    status: result.status,
    runId: result.runId,
    runUrl: result.runUrl,
    reportedAt: result.reportedAt,
    tests: result.tests,
  };
}

/**
 * Adapts CI_STAGE_RESULTS_LOOKUP (Pipelines' port, keyed on repo/branch/sha)
 * into the QaRunAutomation shape the QA runs contract exposes. Kept as its
 * own small service rather than folded into QaRunsService so the Nest/port
 * dependency stays out of the otherwise-pure assembly code there.
 */
@Injectable()
export class QaAutomationService {
  constructor(
    @Inject(CI_STAGE_RESULTS_LOOKUP)
    private readonly stageResults: CiStageResultsLookup,
  ) {}

  async forRun(
    repoFullName: string,
    branch: string,
    commitSha: string,
  ): Promise<QaRunAutomation> {
    const reports = await this.stageResults.latestStageReports({
      repoFullName,
      branch,
      commitSha,
      stages: ['quality', 'verify'],
    });

    const verify = reports.find((report) => report.stage === 'verify');
    const quality = reports.find((report) => report.stage === 'quality');

    return {
      verify: verify ? toStageAutomation(verify) : null,
      quality: quality ? toStageAutomation(quality) : null,
    };
  }
}
