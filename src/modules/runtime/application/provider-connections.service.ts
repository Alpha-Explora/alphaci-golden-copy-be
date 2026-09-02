import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { EnvTokenEncryptionService } from './encryption.service';
import {
  WORKSPACES_PORT,
  type WorkspacesPort,
} from '#kernel/ports/workspaces.port';
import {
  PROVIDER_CLIENT_REGISTRY,
  type ProviderClientRegistryPort,
} from './ports/provider-client-registry.port';
import type { CreateProviderConnectionDto } from '../api/dto/create-provider-connection.dto';
import { ProviderConnectionsRepository } from '../infrastructure/repositories/provider-connections.repository';
import { DeploymentProviderRegistry } from '../core/deployment-provider.registry';
import type { DeploymentProvider } from '../core/deployment-provider.contract';

@Injectable()
export class ProviderConnectionsService {
  constructor(
    private readonly repository: ProviderConnectionsRepository,
    private readonly encryptionService: EnvTokenEncryptionService,
    @Inject(PROVIDER_CLIENT_REGISTRY)
    private readonly clientRegistry: ProviderClientRegistryPort,
    @Optional()
    @Inject(WORKSPACES_PORT)
    private readonly workspacesService?: WorkspacesPort,
    @Optional()
    private readonly providerRegistry?: DeploymentProviderRegistry<DeploymentProvider>,
  ) {}

  async createProviderConnection(
    userId: string,
    dto: CreateProviderConnectionDto,
  ) {
    await this.assertCanManageProviderConnections(userId);
    const provider = this.findProvider(dto.provider);
    if (!provider) {
      throw new BadRequestException('Unsupported provider');
    }
    if (!dto.label?.trim() || !dto.token?.trim()) {
      throw new BadRequestException('Provider label and token are required');
    }

    const token = dto.token.trim();
    const client = this.clientRegistry.getClient(dto.provider);
    const account = await client.validateConnection(token);
    const metadata = provider.prepareConnection
      ? await provider.prepareConnection({
          token,
          config: dto as unknown as Record<string, unknown>,
          account,
          client,
        })
      : {};

    return this.repository.createProviderConnection({
      userId,
      provider: dto.provider,
      label: dto.label.trim(),
      encryptedToken: this.encryptionService.encrypt(token),
      tokenLastFour: token.slice(-4),
      metadata,
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
      (workspace) =>
        workspace.role === 'admin' || workspace.role === 'delegated_lead',
    );
    if (!canManage) {
      throw new ForbiddenException(
        'Provider connection management requires admin or delegated_lead workspace access',
      );
    }
  }

  private findProvider(providerId: string) {
    if (!this.providerRegistry) {
      return undefined;
    }
    try {
      return this.providerRegistry.get(providerId);
    } catch {
      return undefined;
    }
  }
}
