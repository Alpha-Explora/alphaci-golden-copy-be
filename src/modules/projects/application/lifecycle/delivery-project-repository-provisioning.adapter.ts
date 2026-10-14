import { BadRequestException, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import type {
  DeliveryProjectRepositoryProvisioningPort,
  ProvisionDeliveryProjectRepositoryInput,
  ProvisionedDeliveryProjectRepository,
} from '#kernel/ports/delivery-project-repository-provisioning.port';
import {
  DeploymentProvisioningRequestDto,
  type CreateProjectDto,
} from '../../api/dto/create-project.dto';
import { ProjectProvisioningApplicationService } from './project-provisioning-application.service';

/**
 * Implements DELIVERY_PROJECT_REPOSITORY_PROVISIONING for hierarchy's
 * "Add repository" inside a Project. It does not provision anything itself:
 * it hands the request to the same ProjectProvisioningApplicationService the
 * POST /projects wizard uses, with `deliveryProjectId` set so the repository
 * is filed under the existing Project, so workflows and hosting can never
 * drift from what the wizard does. Registered by ProjectProvisioningModule
 * (the @Global bridge), so identity-access needs no import edge into Projects.
 */
@Injectable()
export class DeliveryProjectRepositoryProvisioningAdapter implements DeliveryProjectRepositoryProvisioningPort {
  constructor(
    private readonly provisioning: ProjectProvisioningApplicationService,
  ) {}

  async provisionRepository(
    input: ProvisionDeliveryProjectRepositoryInput,
  ): Promise<ProvisionedDeliveryProjectRepository> {
    // The hosting request arrives as a plain object (identity-access cannot
    // import this DTO), so it gets the exact validation POST /projects applies,
    // before anything is created on GitHub.
    const deploymentProvisioning =
      input.deploymentProvisioning === undefined
        ? undefined
        : await this.validateDeploymentProvisioning(
            input.deploymentProvisioning,
          );

    // exactOptionalPropertyTypes: optional keys are omitted, never undefined.
    const dto = {
      repoName: input.repoName,
      visibility: input.visibility,
      repoShape: input.repoShape ?? 'standalone',
      projectTypeId: input.projectTypeId,
      serviceName: input.serviceName,
      workspaceId: input.workspaceId,
      deliveryProjectId: input.deliveryProjectId,
      ...(input.workflowRecipeId !== undefined && {
        workflowRecipeId: input.workflowRecipeId,
      }),
      ...(input.servicePath !== undefined && {
        servicePath: input.servicePath,
      }),
      ...(input.nodeVersion !== undefined && {
        nodeVersion: input.nodeVersion,
      }),
      ...(input.coverageThreshold !== undefined && {
        coverageThreshold: input.coverageThreshold,
      }),
      ...(input.tests !== undefined && { tests: input.tests }),
      ...(input.outputFileName !== undefined && {
        outputFileName: input.outputFileName,
      }),
      ...(deploymentProvisioning !== undefined && { deploymentProvisioning }),
    } as CreateProjectDto;

    const result = await this.provisioning.createProject(
      input.userId,
      input.userLogin,
      input.githubAccessToken,
      dto,
    );

    return {
      provisionedProjectId: result.id,
      repoFullName: result.repoFullName,
      repoUrl: result.repoUrl,
      workflowPath: result.workflowPath,
      branchesCreated: result.branchesCreated,
      deploymentProvisioning: result.deploymentProvisioning,
    };
  }

  private async validateDeploymentProvisioning(
    raw: unknown,
  ): Promise<DeploymentProvisioningRequestDto> {
    const instance = plainToInstance(DeploymentProvisioningRequestDto, raw);
    const errors = await validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'DEPLOYMENT_PROVISIONING_INVALID',
        message: flattenValidationErrors(errors, 'deploymentProvisioning'),
      });
    }
    return instance;
  }
}

function flattenValidationErrors(
  errors: ValidationError[],
  prefix: string,
): string[] {
  return errors.flatMap((error) => {
    const path = `${prefix}.${error.property}`;
    return [
      ...Object.values(error.constraints ?? {}).map(
        (message) => `${path}: ${message}`,
      ),
      ...flattenValidationErrors(error.children ?? [], path),
    ];
  });
}
