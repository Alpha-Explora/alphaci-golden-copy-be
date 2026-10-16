import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AddProjectEnvironmentDto,
  CreateProjectEnvironmentDto,
} from './project-environment.dto';

const environment = {
  slug: 'staging',
  displayName: 'Staging',
  sourceBranch: 'main',
  role: 'non_production',
  hostAssignment: {
    machineId: '00000000-0000-4000-8000-000000000001',
    requestId: '00000000-0000-4000-8000-000000000002',
    config: { ports: [] },
  },
};
const check = (dto: new () => object) =>
  validate(plainToInstance(dto, environment), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

it('accepts a host assignment only while creating the project', async () => {
  expect(await check(CreateProjectEnvironmentDto)).toHaveLength(0);
});

it('rejects a host assignment when adding an environment, rather than ignoring it', async () => {
  const errors = await check(AddProjectEnvironmentDto);
  expect(errors.map((error) => error.property)).toEqual(['hostAssignment']);
});
