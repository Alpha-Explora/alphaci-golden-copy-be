import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateProjectDto } from './create-project.dto';
import { SetupProjectDto } from './setup-project.dto';

const createBase = {
  repoName: 'repo',
  visibility: 'private',
  projectTypeId: 'nestjs-api',
  serviceName: 'api',
};

const setupBase = {
  templateId: 'be-nestjs',
  serviceName: 'api',
  repoFullName: 'owner/repo',
};

type NamedDto = { projectName?: string };

async function projectNameErrors(
  cls: new () => NamedDto,
  base: Record<string, unknown>,
  projectName: unknown,
) {
  const instance = plainToInstance(cls, { ...base, projectName });
  const errors = await validate(instance);
  return { errors, instance };
}

describe.each([
  ['CreateProjectDto', CreateProjectDto, createBase],
  ['SetupProjectDto', SetupProjectDto, setupBase],
] as const)('%s.projectName', (_label, cls, base) => {
  it('is optional (old callers keep working)', async () => {
    const instance = plainToInstance(cls as new () => NamedDto, base);
    expect(await validate(instance)).toHaveLength(0);
    expect(instance.projectName).toBeUndefined();
  });

  it('trims surrounding whitespace', async () => {
    const { errors, instance } = await projectNameErrors(
      cls,
      base,
      '  Payments Platform  ',
    );
    expect(errors).toHaveLength(0);
    expect(instance.projectName).toBe('Payments Platform');
  });

  it('rejects an empty or whitespace-only name', async () => {
    expect((await projectNameErrors(cls, base, '')).errors).toHaveLength(1);
    expect((await projectNameErrors(cls, base, '   ')).errors).toHaveLength(1);
  });

  it('accepts exactly 80 characters and rejects 81', async () => {
    expect(
      (await projectNameErrors(cls, base, 'a'.repeat(80))).errors,
    ).toHaveLength(0);
    expect(
      (await projectNameErrors(cls, base, 'a'.repeat(81))).errors,
    ).toHaveLength(1);
  });

  it.each(['bad\nname', 'bad\tname', 'bad\u0000name', 'bad\u007fname'])(
    'rejects control characters (%j)',
    async (name) => {
      expect((await projectNameErrors(cls, base, name)).errors).toHaveLength(1);
    },
  );

  it('rejects a non-string value', async () => {
    expect((await projectNameErrors(cls, base, 42)).errors).toHaveLength(1);
  });
});
