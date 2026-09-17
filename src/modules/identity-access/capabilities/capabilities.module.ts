import { Module } from '@nestjs/common';

import { RuntimeCoreModule } from '#modules/runtime/core/runtime-core.module.js';
import { CompositionModule } from '#kernel/composition/composition.module.js';
import { CapabilitiesController } from './api/capabilities.controller';

@Module({
  imports: [RuntimeCoreModule, CompositionModule],
  controllers: [CapabilitiesController],
})
export class CapabilitiesModule {}
