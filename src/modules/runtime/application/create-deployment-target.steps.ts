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

function trimOrNull(value: string | undefined): string | null {
  return value?.trim() || null;
}

function trimOrDefault(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function providerConnectionIdFromDto(
  dto: CreateDeploymentTargetDto,
): string | null {
  return dto.ownershipMode === 'byo'
    ? (dto.providerConnectionId ?? null)
    : null;
}

function mergeProviderMetadata(
  metadata: Record<string, unknown> | undefined,
  renderRuntime: DeploymentProviderTargetPolicyResult['storage']['renderRuntime'],
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    ...(renderRuntime ? { renderRuntime } : {}),
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
  const storage = providerTargetPolicy.storage;
  return {
    projectId,
    slot: dto.slot,
    ownershipMode: dto.ownershipMode,
    provider: dto.provider,
    providerConnectionId: providerConnectionIdFromDto(dto),
    providerProjectId: target.id,
    providerProjectName: target.name,
    repoFullName,
    branchName: trimOrDefault(dto.branchName, 'uat'),
    rootDirectory: trimOrNull(dto.rootDirectory),
    buildCommand: trimOrNull(dto.buildCommand),
    startCommand: trimOrNull(dto.startCommand),
    renderServiceType: orNull(storage.renderServiceType),
    renderInstanceType: orNull(storage.renderInstanceType),
    renderRegion: orNull(storage.renderRegion),
    renderEnvironmentName: orNull(storage.renderEnvironmentName),
    dockerContext: orNull(storage.dockerContext),
    dockerfilePath: orNull(storage.dockerfilePath),
    imageUrl: trimOrNull(dto.imageUrl),
    environmentMap: dto.environmentMap ?? {},
    deploymentStrategy,
    providerMetadata: mergeProviderMetadata(
      target.metadata,
      storage.renderRuntime,
    ),
  };
}
