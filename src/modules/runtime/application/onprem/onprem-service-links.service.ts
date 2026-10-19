import { Inject, Injectable } from '@nestjs/common';
import {
  DEPLOYMENT_PROJECT_REFERENCE_LOOKUP,
  type DeploymentProjectReferenceLookup,
} from '#kernel/ports/deployment-runtime.port';
import {
  PROJECT_LINK_PORT,
  type ProjectLinkPort,
} from '#kernel/ports/project-link.port';
import {
  deriveServiceLink,
  type ServiceLink,
  type ServiceLinkCandidate,
} from '../../domain/onprem-service-link';
import type { MachineBinding } from '../../infrastructure/repositories/onprem-assignments.repository';

/**
 * Links the backend and frontend environments of a two-repository pair that
 * run on the same machine. The pair is recognised by the delivery project
 * (the shared "Project" folder) both repositories are filed under, plus the
 * environment slug. Nothing is stored: every read derives it again.
 */
@Injectable()
export class OnpremServiceLinksService {
  constructor(
    @Inject(PROJECT_LINK_PORT) private readonly folders: ProjectLinkPort,
    @Inject(DEPLOYMENT_PROJECT_REFERENCE_LOOKUP)
    private readonly projects: DeploymentProjectReferenceLookup,
  ) {}

  /**
   * The link of each binding in `wanted`, keyed by binding id. `bindings` must
   * be every active binding on one machine: a sibling that is not among them
   * runs elsewhere, so it is not linked. Lookup failures propagate, so a
   * linked environment is never handed out without its link.
   */
  async linksFor(
    bindings: ReadonlyArray<MachineBinding>,
    wanted: ReadonlySet<string>,
  ): Promise<Map<string, ServiceLink>> {
    const links = new Map<string, ServiceLink>();
    const onMachine = bindings.filter(
      (item): item is MachineBinding & { machine: object } =>
        item.machine !== null,
    );
    if (onMachine.length < 2) return links;
    const folderProjects = new Map<string, Set<string> | null>();
    const slugs = new Map<string, string | null>();
    const slugOf = async (binding: MachineBinding) => {
      if (!slugs.has(binding.environmentId))
        slugs.set(
          binding.environmentId,
          (
            await this.projects.findProjectEnvironment(
              binding.projectId,
              binding.environmentId,
            )
          )?.slug ?? null,
        );
      return slugs.get(binding.environmentId) ?? null;
    };
    for (const self of onMachine) {
      if (!wanted.has(self.id) || self.machine.config.ports.length !== 1)
        continue;
      if (!folderProjects.has(self.projectId)) {
        const folder = await this.folders.getProjectFolder(self.projectId);
        folderProjects.set(
          self.projectId,
          folder
            ? new Set(
                folder.repositories.flatMap((repository) =>
                  repository.projectId ? [repository.projectId] : [],
                ),
              )
            : null,
        );
      }
      const projects = folderProjects.get(self.projectId);
      if (!projects) continue;
      const folderBindings = onMachine.filter(
        (item) =>
          item.machine.config.ports.length === 1 &&
          (item.projectId === self.projectId || projects.has(item.projectId)),
      );
      if (folderBindings.length < 2) continue;
      const candidates: ServiceLinkCandidate[] = [];
      for (const item of folderBindings) {
        const slug = await slugOf(item);
        if (slug === null) continue;
        candidates.push({
          projectId: item.projectId,
          environmentId: item.environmentId,
          slug,
          ports: item.machine.config.ports,
          publicAddress: item.publicAddress,
        });
      }
      const candidate = candidates.find(
        (item) => item.environmentId === self.environmentId,
      );
      const link = candidate && deriveServiceLink(candidate, candidates);
      if (link) links.set(self.id, link);
    }
    return links;
  }
}
