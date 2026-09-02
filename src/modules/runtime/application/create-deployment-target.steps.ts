import { BadRequestException } from '@nestjs/common';

import type { CreateDeploymentTargetInput } from '../infrastructure/deployment-targets.repository';
import type { DeploymentStrategy } from '../core/deployments.types';
import type {
  DeploymentProviderTargetPolicyInput,
  DeploymentProviderTargetPolicyResult,
} from '../core/deployment-provider.policy';
import { DeploymentPolicyViolation } from '../domain/deployment-target.policy';
import type { CreateDeploymentTargetDto } from '../dto/create-deployment-target.dto';
import type { ProviderDeploymentTarget } from './ports/runtime-env-provider.client';

export function mapSlotViolation(error: unknown): never {
  if (error instanceof DeploymentPolicyViolation) {
    throw new BadRequestException(error.policyError.message);
  }
  throw error;
}

export function buildCreateTargetTokenInput(dto: CreateDeploymentTargetDto): {
  ownershipMode: string;
  providerConnectionId?: string;
} {
  const tokenInput: { ownershipMode: string; providerConnectionId?: string } = {
    ownershipMode: dto.ownershipMode,
  };
  if (dto.providerConnectionId) {
    tokenInput.providerConnectionId = dto.providerConnectionId;
  }
  return tokenInput;
}

export function buildProviderTargetRequest(input: {
  dto: CreateDeploymentTargetDto;
  connectionMetadata: Record<string, unknown>;
  managedConfig: Record<string, unknown>;
}): DeploymentProviderTargetPolicyInput {
  const { dto, connectionMetadata, managedConfig } = input;
  return {
    ownershipMode: dto.ownershipMode,
    action: dto.action,
    branchName: dto.branchName?.trim() || 'uat',
    ...(dto.rootDirectory ? { rootDirectory: dto.rootDirectory } : {}),
    ...(dto.imageUrl ? { imageUrl: dto.imageUrl } : {}),
    ...(dto.renderDeployMethod
      ? { renderDeployMethod: dto.renderDeployMethod }
      : {}),
    ...(dto.renderServiceType
      ? { renderServiceType: dto.renderServiceType }
      : {}),
    ...(dto.renderRuntime ? { renderRuntime: dto.renderRuntime } : {}),
    ...(dto.renderInstanceType
      ? { renderInstanceType: dto.renderInstanceType }
      : {}),
    ...(dto.renderRegion ? { renderRegion: dto.renderRegion } : {}),
    ...(dto.renderEnvironmentName
      ? { renderEnvironmentName: dto.renderEnvironmentName }
      : {}),
    ...(dto.dockerContext ? { dockerContext: dto.dockerContext } : {}),
    ...(dto.dockerfilePath ? { dockerfilePath: dto.dockerfilePath } : {}),
    connectionMetadata,
    managedConfig,
  };
}

export function buildCreateTargetPersistInput(input: {
  projectId: string;
  dto: CreateDeploymentTargetDto;
  repoFullName: string;
  target: Pick<ProviderDeploymentTarget, 'id' | 'name' | 'metadata'>;
  providerTargetPolicy: DeploymentProviderTargetPolicyResult;
  deploymentStrategy: DeploymentStrategy;
}): CreateDeploymentTargetInput {
  const {
    projectId,
    dto,
    repoFullName,
    target,
    providerTargetPolicy,
    deploymentStrategy,
  } = input;
  return {
    projectId,
    slot: dto.slot,
    ownershipMode: dto.ownershipMode,
    provider: dto.provider,
    providerConnectionId:
      dto.ownershipMode === 'byo'
        ? (dto.providerConnectionId ?? null)
        : null,
    providerProjectId: target.id,
    providerProjectName: target.name,
    repoFullName,
    branchName: dto.branchName?.trim() || 'uat',
    rootDirectory: dto.rootDirectory?.trim() || null,
    buildCommand: dto.buildCommand?.trim() || null,
    startCommand: dto.startCommand?.trim() || null,
    renderServiceType: providerTargetPolicy.storage.renderServiceType ?? null,
    renderInstanceType:
      providerTargetPolicy.storage.renderInstanceType ?? null,
    renderRegion: providerTargetPolicy.storage.renderRegion ?? null,
    renderEnvironmentName:
      providerTargetPolicy.storage.renderEnvironmentName ?? null,
    dockerContext: providerTargetPolicy.storage.dockerContext ?? null,
    dockerfilePath: providerTargetPolicy.storage.dockerfilePath ?? null,
    imageUrl: dto.imageUrl?.trim() || null,
    environmentMap: dto.environmentMap ?? {},
    deploymentStrategy,
    providerMetadata: {
      ...(target.metadata ?? {}),
      ...(providerTargetPolicy.storage.renderRuntime
        ? { renderRuntime: providerTargetPolicy.storage.renderRuntime }
        : {}),
    },
  };
}
