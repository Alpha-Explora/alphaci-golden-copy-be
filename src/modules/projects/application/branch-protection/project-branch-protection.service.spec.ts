import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { ProjectBranchProtectionService } from './project-branch-protection.service';

describe('ProjectBranchProtectionService', () => {
  let projectsRepository: {
    findByIdAndUser: jest.Mock;
    findAppRole: jest.Mock;
    listVisibleProvisioned: jest.Mock;
  };
  let github: { ensurePullRequestProtection: jest.Mock };
  let tokens: { installationFirst: jest.Mock };
  let audit: { recordProjectEvent: jest.Mock };
  let service: ProjectBranchProtectionService;

  beforeEach(() => {
    projectsRepository = {
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        repo_full_name: 'Acme/Orders',
        workspace_id: 'team-1',
      }),
      findAppRole: jest.fn().mockResolvedValue('admin'),
      listVisibleProvisioned: jest.fn().mockResolvedValue([]),
    };
    github = {
      ensurePullRequestProtection: jest
        .fn()
        .mockResolvedValue({ status: 'applied' }),
    };
    tokens = { installationFirst: jest.fn().mockResolvedValue('install-tok') };
    audit = { recordProjectEvent: jest.fn().mockResolvedValue(undefined) };
    service = new ProjectBranchProtectionService(
      projectsRepository as never,
      github as never,
      tokens as never,
      audit as never,
    );
  });

  describe('applyToProject', () => {
    it('applies the rule to dev, uat and main with the installation token and records it', async () => {
      const result = await service.applyToProject(
        'project-1',
        'user-1',
        'oauth',
      );

      expect(result).toEqual({
        repoFullName: 'Acme/Orders',
        branches: [
          { name: 'dev', status: 'applied' },
          { name: 'uat', status: 'applied' },
          { name: 'main', status: 'applied' },
        ],
      });
      expect(tokens.installationFirst).toHaveBeenCalledWith(
        'Acme/Orders',
        'user-1',
        'oauth',
      );
      // Retrofit: nothing is seeded, so a repository without the env-guard
      // workflow is not given a check that never reports.
      expect(github.ensurePullRequestProtection).toHaveBeenCalledWith(
        'install-tok',
        'Acme',
        'Orders',
        'dev',
      );
      expect(audit.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventCode: 'project_branch_protection_applied',
          projectId: 'project-1',
          workspaceId: 'team-1',
          actorUserId: 'user-1',
        }),
      );
    });

    it('is idempotent: an already protected repository reports unchanged and records nothing', async () => {
      github.ensurePullRequestProtection.mockResolvedValue({
        status: 'unchanged',
      });

      const result = await service.applyToProject('project-1', 'user-1', null);

      expect(result.branches.every((b) => b.status === 'unchanged')).toBe(true);
      expect(audit.recordProjectEvent).not.toHaveBeenCalled();
    });

    it('reports a missing branch and a GitHub 403 per branch, and audits the failure', async () => {
      github.ensurePullRequestProtection
        .mockResolvedValueOnce({ status: 'missing' })
        .mockResolvedValueOnce({
          status: 'failed',
          error: 'HTTP 403 on uat: the credential lacks admin permission',
        })
        .mockRejectedValueOnce(new Error('socket hang up'));

      const result = await service.applyToProject('project-1', 'user-1', null);

      expect(result.branches).toEqual([
        { name: 'dev', status: 'missing' },
        {
          name: 'uat',
          status: 'failed',
          error: 'HTTP 403 on uat: the credential lacks admin permission',
        },
        { name: 'main', status: 'failed', error: 'socket hang up' },
      ]);
      expect(audit.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventCode: 'project_branch_protection_failed',
        }),
      );
    });

    it('is 404 for an invisible project and 403 for a non-admin (allow-list)', async () => {
      projectsRepository.findByIdAndUser.mockResolvedValueOnce(null);
      await expect(
        service.applyToProject('project-1', 'user-1', null),
      ).rejects.toThrow(NotFoundException);

      for (const role of ['lead', 'qa', 'member', 'something-new']) {
        projectsRepository.findAppRole.mockResolvedValue(role);
        await expect(
          service.applyToProject('project-1', 'user-1', null),
        ).rejects.toThrow(ForbiddenException);
      }
      expect(github.ensurePullRequestProtection).not.toHaveBeenCalled();
    });

    it('is 401 when no GitHub credential exists', async () => {
      tokens.installationFirst.mockResolvedValue(null);

      await expect(
        service.applyToProject('project-1', 'user-1', null),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('applyToAll', () => {
    it('refuses everyone but an admin before reading any repository', async () => {
      projectsRepository.findAppRole.mockResolvedValue('lead');

      await expect(service.applyToAll('user-1', null)).rejects.toThrow(
        ForbiddenException,
      );
      expect(projectsRepository.listVisibleProvisioned).not.toHaveBeenCalled();
    });

    it('returns per-repository results, protects a shared repository once and totals the outcomes', async () => {
      projectsRepository.listVisibleProvisioned.mockResolvedValue([
        { id: 'p1', repo_full_name: 'Acme/Orders', workspace_id: 't1' },
        { id: 'p2', repo_full_name: 'acme/orders', workspace_id: 't1' },
        { id: 'p3', repo_full_name: 'Acme/Web', workspace_id: 't1' },
      ]);
      github.ensurePullRequestProtection.mockImplementation(
        (_t: string, _o: string, repo: string, branch: string) =>
          Promise.resolve(
            repo === 'Web' && branch === 'main'
              ? { status: 'failed', error: 'HTTP 404 on main: no admin' }
              : repo === 'Web' && branch === 'dev'
                ? { status: 'missing' }
                : { status: 'applied' },
          ),
      );

      const response = await service.applyToAll('user-1', 'oauth');

      expect(response.results.map((r) => r.repoFullName)).toEqual([
        'Acme/Orders',
        'Acme/Web',
      ]);
      expect(response.results[1]?.branches).toEqual([
        { name: 'dev', status: 'missing' },
        { name: 'uat', status: 'applied' },
        { name: 'main', status: 'failed', error: 'HTTP 404 on main: no admin' },
      ]);
      expect(response.totals).toEqual({
        applied: 4,
        unchanged: 0,
        missing: 1,
        failed: 1,
      });
    });

    it('reports every branch failed for a repository with no usable token, without failing the run', async () => {
      projectsRepository.listVisibleProvisioned.mockResolvedValue([
        { id: 'p1', repo_full_name: 'Acme/Orders', workspace_id: null },
      ]);
      tokens.installationFirst.mockResolvedValue(null);

      const response = await service.applyToAll('user-1', null);

      expect(response.results[0]?.branches.map((b) => b.status)).toEqual([
        'failed',
        'failed',
        'failed',
      ]);
      expect(github.ensurePullRequestProtection).not.toHaveBeenCalled();
    });
  });
});
