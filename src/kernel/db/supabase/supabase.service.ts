import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Optional Supabase Storage client.
 *
 * Only the `supabase` storage driver (STORAGE_DRIVER=supabase, the SaaS
 * default when SUPABASE_URL is present) reads this. Every other path,
 * including database health and the self-hosted deployment, goes through the
 * pg pool in DatabaseService and needs no Supabase credentials.
 */
@Injectable()
export class SupabaseService implements OnModuleInit {
  private client: SupabaseClient | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const url = this.configService.get<string>('SUPABASE_URL')?.trim();
    const key = this.configService
      .get<string>('SUPABASE_SERVICE_ROLE_KEY')
      ?.trim();

    if (!url || !key) {
      return;
    }

    this.client = createClient(url, key, {
      auth: {
        // Service-role key must not persist sessions
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  /** The service-role client, or null when SUPABASE_URL / key are not set. */
  getClient(): SupabaseClient | null {
    return this.client;
  }
}
