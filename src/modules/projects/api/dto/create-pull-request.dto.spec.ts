import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreatePullRequestDto } from './create-pull-request.dto.js';

const check = async (payload: Record<string, unknown>) =>
  validate(plainToInstance(CreatePullRequestDto, payload));

const VALID = { base: 'main', head: 'feature/login', title: 'Add login' };

describe('CreatePullRequestDto', () => {
  it('accepts a minimal pull request', async () => {
    expect(await check(VALID)).toHaveLength(0);
  });

  it('accepts a body and a draft flag', async () => {
    expect(
      await check({ ...VALID, body: 'Why this change', draft: true }),
    ).toHaveLength(0);
  });

  it.each(['has space', '../escape', 'a..b', '-leading', 'what?', 'x~1'])(
    'rejects %p, which git would not accept as a branch name',
    async (head) => {
      const errors = await check({ ...VALID, head });
      expect(errors.map((error) => error.property)).toContain('head');
    },
  );

  it('rejects a missing title', async () => {
    const errors = await check({ ...VALID, title: '' });
    expect(errors.map((error) => error.property)).toContain('title');
  });

  it("rejects a title over GitHub's 256-character limit", async () => {
    const errors = await check({ ...VALID, title: 'x'.repeat(257) });
    expect(errors.map((error) => error.property)).toContain('title');
  });
});
