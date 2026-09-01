import { Module } from '@nestjs/common';

import { CiModule } from './ci/ci.module';
import { GithubModule } from './github/github.module';

/** Bounded-context composition root for source control and CI. */
@Module({
  imports: [GithubModule, CiModule],
  exports: [GithubModule, CiModule],
})
export class PipelinesModule {}
