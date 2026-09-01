import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { DatabaseModule } from '#kernel/db/database.module';
import { CiController } from './ci.controller';
import { CiReportsService } from './ci-reports.service';
import { CiRunReportsRepository } from './ci-run-reports.repository';
import { CiService } from './ci.service';
import { CI_TOKEN_STATUS_LOOKUP } from './ci.contracts';
import { CI_PROJECT_PORT } from '#kernel/ports/ci-project.port';
import { CiTokensRepository } from './infra/ci-tokens.repository';

@Module({
  imports: [DatabaseModule],
  controllers: [CiController],
  providers: [
    CiService,
    { provide: CI_PROJECT_PORT, useExisting: CiService },
    CiTokensRepository,
    {
      provide: CI_TOKEN_STATUS_LOOKUP,
      useExisting: CiTokensRepository,
    },
    CiReportsService,
    CiRunReportsRepository,
    SessionAuthGuard,
  ],
  exports: [
    CiService,
    CI_PROJECT_PORT,
    CiTokensRepository,
    CI_TOKEN_STATUS_LOOKUP,
  ],
})
export class CiModule {}
