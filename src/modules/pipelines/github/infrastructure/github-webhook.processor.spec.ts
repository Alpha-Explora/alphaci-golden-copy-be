import { createHmac } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';

import type { GithubInstallationsRepository } from './github-installations.repository.js';
import { GithubWebhookProcessor } from './github-webhook.processor.js';

const WEBHOOK_SECRET = 'webhook-secret';

const sign = (payload: unknown) => {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')}`;
  return { rawBody, signature };
};

const makeInstallations = () =>
  ({
    beginWebhookDelivery: jest.fn().mockResolvedValue(true),
    completeWebhookDelivery: jest.fn().mockResolvedValue(undefined),
    releaseWebhookDelivery: jest.fn().mockResolvedValue(undefined),
    setSuspended: jest.fn().mockResolvedValue(undefined),
    deleteInstallation: jest.fn().mockResolvedValue(undefined),
    replaceRepos: jest.fn().mockResolvedValue(undefined),
  }) as unknown as GithubInstallationsRepository;

const makeProcessor = (
  installations: GithubInstallationsRepository,
  emit: (event: string, payload: unknown) => void = jest.fn(),
) =>
  new GithubWebhookProcessor({
    getWebhookSecret: () => WEBHOOK_SECRET,
    installations,
    tokens: {
      createInstallationAccessToken: jest.fn().mockResolvedValue('token'),
      fetchInstallationRepositories: jest.fn().mockResolvedValue([]),
    },
    emit,
  });

describe('GithubWebhookProcessor', () => {
  it('verifies the signature and suspends a linked installation', async () => {
    const installations = makeInstallations();
    const processor = makeProcessor(installations);
    const payload = {
      action: 'suspend',
      installation: { id: 12345 },
    };
    const { rawBody, signature } = sign(payload);

    await expect(
      processor.handleWebhook(
        signature,
        'installation',
        'delivery-1',
        rawBody,
        payload,
      ),
    ).resolves.toEqual({ accepted: true });

    expect(installations.setSuspended).toHaveBeenCalledWith(12345, true);
    expect(installations.completeWebhookDelivery).toHaveBeenCalledWith(
      'delivery-1',
    );
  });

  it('rejects an invalid webhook signature', async () => {
    const processor = makeProcessor(makeInstallations());

    await expect(
      processor.handleWebhook(
        'sha256=invalid',
        'installation',
        'delivery-2',
        Buffer.from('{}'),
        {},
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      processor.handleWebhook(
        'sha256=invalid',
        'installation',
        'delivery-2',
        Buffer.from('{}'),
        {},
      ),
    ).rejects.toThrow('Invalid GitHub webhook signature');
  });

  it('emits repository.deleted with the repo full_name', async () => {
    const emit = jest.fn();
    const processor = makeProcessor(makeInstallations(), emit);
    const payload = {
      action: 'deleted',
      repository: { full_name: 'Alpha-Explora/some-repo' },
      installation: { id: 12345 },
    };
    const { rawBody, signature } = sign(payload);

    await expect(
      processor.handleWebhook(
        signature,
        'repository',
        'delivery-repo-1',
        rawBody,
        payload,
      ),
    ).resolves.toEqual({ accepted: true });

    expect(emit).toHaveBeenCalledWith('repository.deleted', {
      repoFullName: 'Alpha-Explora/some-repo',
    });
  });

  it('returns duplicate when beginWebhookDelivery is false', async () => {
    const installations = makeInstallations();
    (installations.beginWebhookDelivery as jest.Mock).mockResolvedValue(false);
    const processor = makeProcessor(installations);
    const payload = {
      action: 'suspend',
      installation: { id: 12345 },
    };
    const { rawBody, signature } = sign(payload);

    await expect(
      processor.handleWebhook(
        signature,
        'installation',
        'delivery-dup',
        rawBody,
        payload,
      ),
    ).resolves.toEqual({ accepted: true, duplicate: true });

    expect(installations.setSuspended).not.toHaveBeenCalled();
    expect(installations.completeWebhookDelivery).not.toHaveBeenCalled();
  });

  it('emits team.membership.changed for added and removed', async () => {
    const emit = jest.fn();
    const processor = makeProcessor(makeInstallations(), emit);
    const payload = {
      action: 'removed',
      member: { login: 'octocat' },
      team: { slug: 'team-lead' },
      installation: { id: 99 },
    };
    const { rawBody, signature } = sign(payload);

    await processor.handleWebhook(
      signature,
      'membership',
      'delivery-mem-1',
      rawBody,
      payload,
    );

    expect(emit).toHaveBeenCalledWith('team.membership.changed', {
      action: 'removed',
      login: 'octocat',
      teamSlug: 'team-lead',
      installationId: 99,
    });
  });

  it('deletes an installation on installation.deleted', async () => {
    const installations = makeInstallations();
    const processor = makeProcessor(installations);
    const payload = { action: 'deleted', installation: { id: 7 } };
    const { rawBody, signature } = sign(payload);

    await processor.handleWebhook(
      signature,
      'installation',
      'delivery-del-1',
      rawBody,
      payload,
    );

    expect(installations.deleteInstallation).toHaveBeenCalledWith(7);
  });

  it('replaces repos on installation_repositories', async () => {
    const installations = makeInstallations();
    const processor = makeProcessor(installations);
    const payload = { action: 'added', installation: { id: 5 } };
    const { rawBody, signature } = sign(payload);

    await processor.handleWebhook(
      signature,
      'installation_repositories',
      'delivery-repos-1',
      rawBody,
      payload,
    );

    expect(installations.replaceRepos).toHaveBeenCalledWith(5, []);
  });
});
