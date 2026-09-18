import { NestFactory } from '@nestjs/core';

import { TenantProvisioningService } from '../src/modules/identity-access/tenancy/application/tenant-provisioning.service.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function valueFor(flag: string): string | undefined {
  const argumentsList = process.argv.slice(2);
  const index = argumentsList.findIndex(
    (argument) => argument === flag || argument.startsWith(`${flag}=`),
  );
  const argument = argumentsList[index];
  if (argument?.startsWith(`${flag}=`)) {
    return argument.slice(flag.length + 1).trim() || undefined;
  }
  const next = index >= 0 ? argumentsList[index + 1] : undefined;
  return next && !next.startsWith('--') ? next.trim() : undefined;
}

function requiredValue(flag: string): string {
  const value = valueFor(flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function hasFlag(flag: string): boolean {
  return process.argv
    .slice(2)
    .some((argument) => argument === flag || argument.startsWith(`${flag}=`));
}

function usage(): string {
  return [
    'Usage:',
    '  npm run db:provision-tenant -- --tenant-id <uuid> --name <name> --slug <slug> --kind <customer|institution|enterprise> --deployment-mode <hosted|enterprise> --user-id <uuid> [--role <owner|admin|member|viewer>] [--apply] [--confirm-production]',
    '',
    'Without --apply the command validates the operator-supplied values and prints the intended mapping only.',
    'The command never derives a tenant from edition, email, row order, or database location.',
  ].join('\n');
}

function assertUuid(value: string, flag: string): void {
  if (!UUID_RE.test(value)) throw new Error(`${flag} must be a UUID`);
}

function assertOneOf<T extends string>(
  value: string,
  flag: string,
  values: readonly T[],
): T {
  if (!values.includes(value as T)) {
    throw new Error(`${flag} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

async function main(): Promise<void> {
  if (hasFlag('--help')) {
    console.log(usage());
    return;
  }

  const tenantId = requiredValue('--tenant-id');
  const name = requiredValue('--name');
  const slug = requiredValue('--slug').toLowerCase();
  const kind = assertOneOf(requiredValue('--kind'), '--kind', [
    'customer',
    'institution',
    'enterprise',
  ] as const);
  const deploymentMode = assertOneOf(
    requiredValue('--deployment-mode'),
    '--deployment-mode',
    ['hosted', 'enterprise'] as const,
  );
  const userId = requiredValue('--user-id');
  const role = assertOneOf(valueFor('--role') ?? 'owner', '--role', [
    'owner',
    'admin',
    'member',
    'viewer',
  ] as const);

  assertUuid(tenantId, '--tenant-id');
  assertUuid(userId, '--user-id');
  if (!name.trim()) throw new Error('--name is required');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new Error(
      '--slug must contain lowercase letters, numbers, and hyphens',
    );
  }

  const databaseUrl = process.env['SUPABASE_DB_URL'];
  if (!databaseUrl) throw new Error('SUPABASE_DB_URL is required');
  const databaseTarget = new URL(databaseUrl);
  const dryRun = !hasFlag('--apply');

  console.log(
    `${dryRun ? 'Dry-run' : 'Provisioning'} tenant ${tenantId} against ${databaseTarget.hostname}`,
  );

  if (
    !dryRun &&
    process.env['NODE_ENV'] === 'production' &&
    !hasFlag('--confirm-production')
  ) {
    throw new Error(
      'Refusing a production write without --confirm-production; rerun dry-run first and verify the target hostname.',
    );
  }

  const mapping = {
    tenantId,
    name: name.trim(),
    slug,
    kind,
    deploymentMode,
    initialMembership: { userId, role },
  };

  if (dryRun) {
    console.log(JSON.stringify(mapping, null, 2));
    return;
  }

  const { AppModule } = await import('../src/app.module.js');
  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const service = application.get(TenantProvisioningService);
    const tenant = await service.provisionTenant(mapping);
    console.log(
      JSON.stringify({ ...tenant, membershipUserId: userId, role }, null, 2),
    );
  } finally {
    await application.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
