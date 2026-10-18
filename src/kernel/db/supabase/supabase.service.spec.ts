import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '#kernel/db/supabase/supabase.service';

function makeConfigService(
  url: string | undefined,
  key: string | undefined,
): Partial<ConfigService> {
  return {
    get: jest.fn().mockImplementation((k: string) => {
      if (k === 'SUPABASE_URL') return url;
      if (k === 'SUPABASE_SERVICE_ROLE_KEY') return key;
      return undefined;
    }),
  };
}

async function createService(
  url: string | undefined,
  key: string | undefined,
): Promise<SupabaseService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SupabaseService,
      { provide: ConfigService, useValue: makeConfigService(url, key) },
    ],
  }).compile();

  const service = module.get<SupabaseService>(SupabaseService);
  // The testing module does not run lifecycle hooks; trigger it explicitly.
  service.onModuleInit();
  return service;
}

describe('SupabaseService', () => {
  it('builds a storage client when URL and service-role key are set', async () => {
    const service = await createService(
      'https://abc.supabase.co',
      'service-role-key',
    );

    expect(service.getClient()).not.toBeNull();
  });

  it('has no client when the URL is missing', async () => {
    const service = await createService(undefined, 'service-role-key');

    expect(service.getClient()).toBeNull();
  });

  it('has no client when the service-role key is missing', async () => {
    const service = await createService('https://abc.supabase.co', undefined);

    expect(service.getClient()).toBeNull();
  });

  it('has no client when both are blank', async () => {
    const service = await createService('   ', '');

    expect(service.getClient()).toBeNull();
  });
});
