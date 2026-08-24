import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { DatabaseModule } from '../../kernel/db/database.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { CiController } from './ci.controller';
import { CiReportsService } from './ci-reports.service';
import { CiRunReportsRepository } from './ci-run-reports.repository';
import { CiService } from './ci.service';
import { CiTokensRepository } from './ci-tokens.repository';

@Module({
  imports: [
    DatabaseModule,
    PersistenceModule, // UsersRepository needed by SessionAuthGuard
  ],
  controllers: [CiController],
  providers: [
    CiService,
    CiTokensRepository,
    CiReportsService,
    CiRunReportsRepository,
    SessionAuthGuard,
  ],
  exports: [CiService],
})
export class CiModule {}
