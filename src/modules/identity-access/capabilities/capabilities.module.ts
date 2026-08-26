import { Module } from '@nestjs/common';

import { RuntimeCoreModule } from '#modules/runtime/core/runtime-core.module.js';
import { CapabilitiesController } from './capabilities.controller';

@Module({
  imports: [RuntimeCoreModule],
  controllers: [CapabilitiesController],
})
export class CapabilitiesModule {}
