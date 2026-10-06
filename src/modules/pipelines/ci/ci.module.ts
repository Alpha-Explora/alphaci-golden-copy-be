import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { DatabaseModule } from '#kernel/db/database.module';
import { CiController } from './api/ci.controller';
import { CiVisualController } from './api/ci-visual.controller';
import { CiActiveTokenGuard } from './api/ci-bearer';
import { VisualRegressionService } from './application/visual-regression.service';
import { VisualRegressionRepository } from './infrastructure/visual-regression.repository';
import { VISUAL_REGRESSION_PORT } from '#kernel/ports/visual-regression.port';
import { CiReportsService } from './application/ci-reports.service';
import { CiRunReportsRepository } from './infrastructure/ci-run-reports.repository';
import { CiService } from './application/ci.service';
import { CI_TOKEN_STATUS_LOOKUP } from './application/ci.contracts';
import {
  CI_PROJECT_PORT,
  CI_RUN_VALIDATION,
} from '#kernel/ports/ci-project.port';
import { CI_STAGE_RESULTS_LOOKUP } from '#kernel/ports/ci-stage-results.port';
import { CiTokensRepository } from './infrastructure/ci-tokens.repository';

@Module({
  imports: [DatabaseModule],
  controllers: [CiController, CiVisualController],
  providers: [
    CiService,
    { provide: CI_PROJECT_PORT, useExisting: CiService },
    { provide: CI_RUN_VALIDATION, useExisting: CiService },
    CiTokensRepository,
    {
      provide: CI_TOKEN_STATUS_LOOKUP,
      useExisting: CiTokensRepository,
    },
    CiReportsService,
    CiRunReportsRepository,
    {
      provide: CI_STAGE_RESULTS_LOOKUP,
      useExisting: CiRunReportsRepository,
    },
    SessionAuthGuard,
    CiActiveTokenGuard,
    VisualRegressionRepository,
    VisualRegressionService,
    {
      provide: VISUAL_REGRESSION_PORT,
      useExisting: VisualRegressionService,
    },
  ],
  exports: [
    CiService,
    CI_PROJECT_PORT,
    CI_RUN_VALIDATION,
    CiTokensRepository,
    CI_TOKEN_STATUS_LOOKUP,
    CI_STAGE_RESULTS_LOOKUP,
    VISUAL_REGRESSION_PORT,
  ],
})
export class CiModule {}
