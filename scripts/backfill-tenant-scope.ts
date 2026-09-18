import { NestFactory } from '@nestjs/core';

import { TenantProvisioningService } from '../src/modules/identity-access/tenancy/application/tenant-provisioning.service.js';

type DeploymentMode = 'hosted' | 'enterprise';

function valuesFor(flag: string): string[] {
  const values: string[] = [];
  const argumentsList = process.argv.slice(2);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === flag) {
      const next = argumentsList[index + 1];
      if (next && !next.startsWith('--')) values.push(next);
      index += 1;
      continue;
    }
    if (argument?.startsWith(`${flag}=`)) {
      values.push(argument.slice(flag.length + 1));
    }
  }
  return values;
}

function requiredValue(flag: string): string {
  const value = valuesFor(flag)[0]?.trim();
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
    '  npm run db:backfill-tenant-scope -- --tenant-id <uuid> --deployment-mode <hosted|enterprise> [--workspace-id <uuid> ...] [--project-id <uuid> ...] [--workflow-generation-id <uuid> ...] [--provider-connection-id <uuid> ...] [--ci-run-report-id <uuid> ...] [--apply] [--confirm-production]',
    '',
    'Without --apply the command is a dry run. It never infers tenant ownership from edition, email, or database location.',
  ].join('\n');
}

async function main(): Promise<void> {
  if (hasFlag('--help')) {
    console.log(usage());
    return;
  }

  const tenantId = requiredValue('--tenant-id');
  const deploymentMode = requiredValue('--deployment-mode') as DeploymentMode;
  if (deploymentMode !== 'hosted' && deploymentMode !== 'enterprise') {
    throw new Error('--deployment-mode must be hosted or enterprise');
  }

  const workspaceIds = valuesFor('--workspace-id');
  const projectIds = valuesFor('--project-id');
  const workflowGenerationIds = valuesFor('--workflow-generation-id');
  const providerConnectionIds = valuesFor('--provider-connection-id');
  const ciRunReportIds = valuesFor('--ci-run-report-id');
  if (
    workspaceIds.length === 0 &&
    projectIds.length === 0 &&
    workflowGenerationIds.length === 0 &&
    providerConnectionIds.length === 0 &&
    ciRunReportIds.length === 0
  ) {
    throw new Error(
      'At least one explicit workspace, project, workflow-generation, or provider-connection id is required',
    );
  }
  const dryRun = !hasFlag('--apply');
  const databaseUrl = process.env['SUPABASE_DB_URL'];
  if (!databaseUrl) throw new Error('SUPABASE_DB_URL is required');

  const databaseTarget = new URL(databaseUrl);
  console.log(
    `${dryRun ? 'Dry-run' : 'Applying'} tenant backfill against ${databaseTarget.hostname} for tenant ${tenantId}`,
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

  const { AppModule } = await import('../src/app.module.js');
  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const service = application.get(TenantProvisioningService);
    const summary = await service.backfillWorkspaceScope({
      tenantId,
      deploymentMode,
      dryRun,
      selection: {
        kind: 'explicit-ids',
        workspaceIds,
        projectIds,
        workflowGenerationIds,
        providerConnectionIds,
        ciRunReportIds,
      },
    });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await application.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
