import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';

Object.assign(process.env, {
  NODE_ENV: 'test',
  SESSION_STORE_DRIVER: 'memory',
  SESSION_SECRET: 'test-only-session-secret-that-is-at-least-32-bytes',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  ALLOWED_ORIGINS: 'http://localhost:3000',
  FRONTEND_URL: 'http://localhost:3000',
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  ENV_PROVISIONING_ENABLED: 'false',
  ENV_PROVISIONING_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
});

// `app.module.ts` validates required configuration during module evaluation;
// require it only after the fixture above has populated process.env.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHttpApplication } =
  require('../../src/main.js') as typeof import('../../src/main.js');

function routeSet(document: OpenAPIObject): string[] {
  return Object.entries(document.paths)
    .flatMap(([path, operations]) =>
      Object.keys(operations)
        .filter((method) => method !== 'parameters')
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

describe('HTTP route inventory', () => {
  it('matches the post-consolidation route reference exactly', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('AlphaCI route inventory').build(),
      );
      const actual = routeSet(document);
      const reference = readFileSync(
        resolve(
          __dirname,
          '../../docs/architecture/route-inventory.pre-consolidation.txt',
        ),
        'utf8',
      )
        .split(/\r?\n/)
        .filter(Boolean);
      const manifest = JSON.parse(
        readFileSync(
          resolve(
            __dirname,
            '../../docs/architecture/route-inventory.manifest.json',
          ),
          'utf8',
        ),
      ) as {
        routeCount: number;
        referenceKind: string;
        preConsolidationBaselineAvailable: boolean;
        preConsolidationBaselineFile: string;
        preConsolidationBaselineSha256: string;
        preConsolidationSourceCommit: string;
        referenceFile: string;
        referenceSha256: string;
      };
      const preConsolidationReference = readFileSync(
        resolve(
          __dirname,
          '../../docs/architecture/route-inventory.pre-consolidation.txt',
        ),
        'utf8',
      );
      const sha256 = (value: string) =>
        createHash('sha256').update(value, 'utf8').digest('hex');

      expect(actual).toEqual(reference);
      expect(actual).toHaveLength(manifest.routeCount);
      expect(manifest.referenceFile).toBe(
        'route-inventory.pre-consolidation.txt',
      );
      expect(sha256(reference.join('\n') + '\n')).toBe(
        manifest.referenceSha256,
      );
      expect(manifest.referenceKind).toBe(
        'pre-consolidation-reference-equals-current',
      );
      expect(manifest.preConsolidationBaselineAvailable).toBe(true);
      expect(manifest.preConsolidationBaselineFile).toBe(
        'route-inventory.pre-consolidation.txt',
      );
      expect(sha256(preConsolidationReference)).toBe(
        manifest.preConsolidationBaselineSha256,
      );
      expect(manifest.preConsolidationSourceCommit).toBe('b175938');
      expect(preConsolidationReference).toBe(reference.join('\n') + '\n');
    } finally {
      await app.close();
    }
  }, 60_000);
});
