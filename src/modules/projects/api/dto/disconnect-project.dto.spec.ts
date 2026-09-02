import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { DisconnectProjectDto } from './disconnect-project.dto.js';

const validate1 = async (payload: Record<string, unknown>) => {
  const instance = plainToInstance(DisconnectProjectDto, payload);
  return validate(instance);
};

describe('DisconnectProjectDto', () => {
  it('accepts an empty body (plain disconnect, default off)', async () => {
    const errors = await validate1({});
    expect(errors).toHaveLength(0);
  });

  it('accepts deleteGithubRepo: false with no confirmRepoName', async () => {
    const errors = await validate1({ deleteGithubRepo: false });
    expect(errors).toHaveLength(0);
  });

  it('accepts deleteGithubRepo: true with a confirmRepoName', async () => {
    const errors = await validate1({
      deleteGithubRepo: true,
      confirmRepoName: 'my-org/my-repo',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects deleteGithubRepo: true without a confirmRepoName', async () => {
    const errors = await validate1({ deleteGithubRepo: true });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'confirmRepoName')).toBe(true);
  });

  it('rejects deleteGithubRepo: true with an empty confirmRepoName', async () => {
    const errors = await validate1({
      deleteGithubRepo: true,
      confirmRepoName: '',
    });
    expect(errors.some((e) => e.property === 'confirmRepoName')).toBe(true);
  });

  it('rejects a non-boolean deleteGithubRepo', async () => {
    const errors = await validate1({ deleteGithubRepo: 'yes' });
    expect(errors.some((e) => e.property === 'deleteGithubRepo')).toBe(true);
  });

  it('does not require confirmRepoName to match anything at the DTO layer — that is a service-level check', async () => {
    // The DTO only validates shape; the server-side re-validation against
    // the project's actual repo_full_name happens in
    // ProjectsService.disconnectProject, not here.
    const errors = await validate1({
      deleteGithubRepo: true,
      confirmRepoName: 'anything-nonempty',
    });
    expect(errors).toHaveLength(0);
  });
});
