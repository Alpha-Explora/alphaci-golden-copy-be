import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  APP_ROLE_LOOKUP,
  type AppRoleLookup,
} from '#kernel/ports/app-role.port';
import { canManageEnvVars } from '#kernel/rules/persona-access.rules';
import { HierarchyAccessService } from './hierarchy-access.service';
import {
  HIERARCHY_EVENT_CODES,
  type EnvironmentScope,
} from '../domain/hierarchy.types';
import {
  RepositoriesRepository,
  type RepositoryRecord,
} from '../infrastructure/repositories.repository';
import {
  GITHUB_SECRETS_BROKER,
  type GithubSecretsBroker,
} from './github-secrets.broker';
import { RepoConfigurationChangesRepository } from '../infrastructure/repo-configuration-changes.repository';

const VARIABLE_NAME_PATTERN = /^[A-Za-z_]\w{0,127}$/;

@Injectable()
export class RepoConfigBrokerService {
  constructor(
    private readonly repositoriesRepository: RepositoriesRepository,
    private readonly accessService: HierarchyAccessService,
    private readonly changesRepository: RepoConfigurationChangesRepository,
    @Inject(GITHUB_SECRETS_BROKER)
    private readonly secretsProvider: GithubSecretsBroker,
    private readonly auditEventsService: AuditEventPublisher,
    // Required (not @Optional): the write gate must never silently vanish.
    @Inject(APP_ROLE_LOOKUP)
    private readonly appRoleLookup: AppRoleLookup,
  ) {}

  async listConfiguration(
    repositoryId: string,
    userId: string,
  ): Promise<{
    variables: Array<{
      name: string;
      environmentScope: EnvironmentScope;
      updatedAt: string;
    }>;
    secrets: Array<{
      name: string;
      environmentScope: EnvironmentScope;
      updatedAt: string;
    }>;
  }> {
    await this.accessService.assertRepositoryVisible(repositoryId, userId);
    const [variables, secrets] = await Promise.all([
      this.changesRepository.listCurrentNames(repositoryId, 'variable'),
      this.changesRepository.listCurrentNames(repositoryId, 'secret'),
    ]);
    return { variables, secrets };
  }

  async writeVariable(
    repositoryId: string,
    userId: string,
    name: string,
    value: string,
    environmentScope: EnvironmentScope,
  ): Promise<{ written: true }> {
    return this.write(repositoryId, userId, {
      name,
      value,
      environmentScope,
      configurationType: 'variable',
    });
  }

  async writeSecret(
    repositoryId: string,
    userId: string,
    name: string,
    value: string,
    environmentScope: EnvironmentScope,
  ): Promise<{ written: true }> {
    return this.write(repositoryId, userId, {
      name,
      value,
      environmentScope,
      configurationType: 'secret',
    });
  }

  async deleteConfiguration(
    repositoryId: string,
    userId: string,
    configurationType: 'variable' | 'secret',
    name: string,
  ): Promise<{ deleted: true }> {
    if (configurationType !== 'variable' && configurationType !== 'secret') {
      throw new BadRequestException(
        'configurationType must be variable or secret',
      );
    }
    this.assertValidName(name);
    const { groupId, repository } = await this.assertWriteAccess(
      repositoryId,
      userId,
      // Delete has no request-body environmentScope; production repository
      // config is hard-blocked at write-time already, so a delete here only
      // ever targets a previously-written non_production entry. Passing
      // 'non_production' keeps the same access rule (lead/admin app_role, no
      // assignment shortcut) without re-deriving scope from history.
      'non_production',
    );

    const [owner, repo] = (repository.repoFullName ?? '').split('/');
    const token = await this.secretsProvider.resolveInstallationToken(userId);
    if (owner && repo) {
      if (configurationType === 'variable') {
        await this.secretsProvider.deleteVariable({ token, owner, repo, name });
      } else {
        await this.secretsProvider.deleteSecret({ token, owner, repo, name });
      }
    }

    await this.changesRepository.record({
      repositoryId,
      requestedBy: userId,
      environmentScope: 'non_production',
      configurationType,
      action: 'delete',
      variableName: name,
      approvalState: 'not_required',
      githubSyncState: 'synced',
    });

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode:
        configurationType === 'variable'
          ? HIERARCHY_EVENT_CODES.configurationVariableDeleted
          : HIERARCHY_EVENT_CODES.configurationSecretDeleted,
      message: `Repository ${configurationType} "${name}" deleted`,
      // Never include the value — this event only records the name.
      metadata: { repositoryId, configurationType, variableName: name },
    });

    return { deleted: true };
  }

  private async write(
    repositoryId: string,
    userId: string,
    input: {
      name: string;
      value: string;
      environmentScope: EnvironmentScope;
      configurationType: 'variable' | 'secret';
    },
  ): Promise<{ written: true }> {
    this.assertValidName(input.name);
    const { groupId, repository } = await this.assertWriteAccess(
      repositoryId,
      userId,
      input.environmentScope,
    );

    const [owner, repo] = (repository.repoFullName ?? '').split('/');
    if (!owner || !repo) {
      throw new ForbiddenException(
        'Repository has no linked GitHub full name yet',
      );
    }
    const token = await this.secretsProvider.resolveInstallationToken(userId);

    if (input.configurationType === 'variable') {
      await this.secretsProvider.writeVariable({
        token,
        owner,
        repo,
        name: input.name,
        value: input.value,
      });
    } else {
      await this.secretsProvider.writeSecret({
        token,
        owner,
        repo,
        name: input.name,
        value: input.value,
      });
    }

    await this.changesRepository.record({
      repositoryId,
      requestedBy: userId,
      environmentScope: input.environmentScope,
      configurationType: input.configurationType,
      action: 'create',
      variableName: input.name,
      approvalState: 'not_required',
      githubSyncState: 'synced',
    });

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode:
        input.configurationType === 'variable'
          ? HIERARCHY_EVENT_CODES.configurationVariableWritten
          : HIERARCHY_EVENT_CODES.configurationSecretWritten,
      message: `Repository ${input.configurationType} "${input.name}" written`,
      // Value never recorded — name/metadata only (security contract "secret values
      // must never be recorded, displayed, or made exportable").
      metadata: {
        repositoryId,
        configurationType: input.configurationType,
        variableName: input.name,
        environmentScope: input.environmentScope,
      },
    });

    return { written: true };
  }

  /**
   * Production is hard-blocked this session regardless of role (configuration safety rule) —
   * checked AFTER confirming the caller can see the repository at all, so an
   * unrelated caller still gets 404 (existence-hiding, resource visibility rule) rather than
   * a 403 that would confirm the repository exists.
   */
  private async assertWriteAccess(
    repositoryId: string,
    userId: string,
    environmentScope: EnvironmentScope,
  ): Promise<{
    groupId: string;
    viaManager: boolean;
    repository: RepositoryRecord;
  }> {
    const { repository, viaManager } =
      await this.accessService.assertRepositoryVisible(repositoryId, userId);

    // Repository-level GitHub Actions secrets/variables are written with an
    // installation token, so the authority is the global app_role allow-list
    // (admin | member), not manager/assignee derivation. Visibility (404)
    // came first above; an unresolved role is refused (fail closed).
    const role = await this.appRoleLookup.findAppRole(userId);
    if (!canManageEnvVars(role)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'ENV_VARS_LEAD_ONLY',
        message:
          'Only Developers and admins can change repository secrets and variables.',
      });
    }

    if (environmentScope === 'production') {
      throw new ForbiddenException(
        'Production environment configuration requires the protected approval workflow, which is not yet available',
      );
    }

    return { groupId: repository.groupId, viaManager, repository };
  }

  private assertValidName(name: string): void {
    if (!VARIABLE_NAME_PATTERN.test(name)) {
      throw new BadRequestException('Invalid configuration name');
    }
  }
}
