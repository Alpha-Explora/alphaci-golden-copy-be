import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { SupabaseModule } from '#kernel/db/supabase/supabase.module.js';

@Module({
  imports: [SupabaseModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
