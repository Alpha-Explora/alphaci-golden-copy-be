import { Global, Module } from '@nestjs/common';
import { SupabaseService } from '#kernel/db/supabase/supabase.service.js';

@Global()
@Module({
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}
