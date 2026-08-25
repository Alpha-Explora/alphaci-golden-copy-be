import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { EnvTokenEncryptionService } from './encryption.service';
import type { CreateProviderConnectionDto } from './dto/create-provider-connection.dto';
import type { EnvProvider } from './deployments.types';
import { ProviderClientRegistry } from './infrastructure/providers/core/provider-client.registry';
import { ProviderConnectionsRepository } from './provider-connections.repository';
import { WorkspacesService } from '../workspaces/index.js';

const PROVIDERS: EnvProvider[] = ['render', 'vercel'];
type ProviderTeamSummary = { id: string; slug?: string; name?: string };

@Injectable()
export class ProviderConnectionsService {
  constructor(
    private readonly repository: ProviderConnectionsRepository,
    private readonly encryptionService: EnvTokenEncryptionService,
    private readonly clientRegistry: ProviderClientRegistry,
    @Optional()
    private readonly workspacesService?: WorkspacesService,
  ) {}

  async createProviderConnection(
    userId: string,
    dto: CreateProviderConnectionDto,
  ) {
    await this.assertCanManageProviderConnections(userId);
    if (!PROVIDERS.includes(dto.provider)) {
      throw new BadRequestException('Unsupported provider');
    }
    if (!dto.label?.trim() || !dto.token?.trim()) {
      throw new BadRequestException('Provider label and token are required');
    }

    const token = dto.token.trim();
    const client = this.clientRegistry.getClient(dto.provider);
    const account = await client.validateConnection(token);
    const teamId = dto.vercelTeamId?.trim();
    const team =
      dto.provider === 'vercel' && teamId
        ? await this.validateVercelTeamAccess(client, token, teamId)
        : undefined;

    return this.repository.createProviderConnection({
      userId,
      provider: dto.provider,
      label: dto.label.trim(),
      encryptedToken: this.encryptionService.encrypt(token),
      tokenLastFour: token.slice(-4),
      metadata: this.buildConnectionMetadata(dto, account, team),
    });
  }

  listProviderConnections(userId: string) {
    return this.repository.listProviderConnections(userId);
  }

  async revokeProviderConnection(id: string, userId: string) {
    await this.assertCanManageProviderConnections(userId);
    const revoked = await this.repository.revokeProviderConnection(id, userId);
    if (!revoked) {
      throw new NotFoundException('Provider connection not found');
    }

    return { revoked: true };
  }

  private async assertCanManageProviderConnections(
    userId: string,
  ): Promise<void> {
    if (!this.workspacesService) {
      return;
    }

    const workspaces = await this.workspacesService.getMyWorkspaces(userId);
    const canManage = workspaces.items.some(
      (workspace) => workspace.role === 'admin' || workspace.role === 'delegated_lead',
    );
    if (!canManage) {
      throw new ForbiddenException(
        'Provider connection management requires admin or delegated_lead workspace access',
      );
    }
  }

  private buildConnectionMetadata(
    dto: CreateProviderConnectionDto,
    account: { id: string; metadata?: Record<string, unknown> },
    team?: ProviderTeamSummary,
  ): Record<string, unknown> {
    if (dto.provider !== 'vercel') {
      return {};
    }

    const teamId = team?.id ?? dto.vercelTeamId?.trim();
    const teamSlug = team?.slug ?? dto.vercelTeamSlug?.trim();
    if (teamSlug && !teamId) {
      throw new BadRequestException(
        'vercelTeamId is required when connecting a Vercel team',
      );
    }

    if (teamId) {
      return {
        accountType: 'team',
        orgId: teamId,
        teamId,
        ...(teamSlug ? { teamSlug } : {}),
      };
    }

    return {
      accountType: 'user',
      orgId: account.metadata?.['orgId'] ?? account.id,
    };
  }

  private validateVercelTeamAccess(
    client: {
      validateTeamAccess?: (
        token: string,
        teamId: string,
      ) => Promise<ProviderTeamSummary>;
    },
    token: string,
    teamId: string,
  ): Promise<ProviderTeamSummary> {
    if (!client.validateTeamAccess) {
      throw new BadRequestException(
        'Vercel team validation is not supported by this provider client',
      );
    }

    return client.validateTeamAccess(token, teamId);
  }
}
