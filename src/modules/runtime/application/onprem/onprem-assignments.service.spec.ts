import { BadRequestException } from '@nestjs/common';
import type { AssignmentConfig } from '#kernel/ports/onprem-assignment.port';
import { validateAssignmentConfig } from './onprem-assignments.service';
const config: AssignmentConfig = {
  ports: [{ slot: 'frontend', hostPort: 8080, containerPort: 3000 }],
  health: [{ slot: 'frontend', path: '/' }],
  ingress: { mode: 'direct', publicUrl: null },
};
it('supports only the slots actually deployed', () => {
  expect(() =>
    validateAssignmentConfig(config, ['frontend'], false),
  ).not.toThrow();
  expect(() =>
    validateAssignmentConfig(config, ['frontend', 'backend'], false),
  ).toThrow(BadRequestException);
});
it.each([
  '//other.example',
  '/../secret',
  '/%2e%2e/foo',
  'http://localhost:4000',
  '/\\admin',
])('rejects escaping health path %s', (path) => {
  expect(() =>
    validateAssignmentConfig(
      { ...config, health: [{ slot: 'frontend', path }] },
      ['frontend'],
      false,
    ),
  ).toThrow(BadRequestException);
});
it('requires explicit production HTTPS ingress', () => {
  expect(() => validateAssignmentConfig(config, ['frontend'], true)).toThrow(
    BadRequestException,
  );
  expect(() =>
    validateAssignmentConfig(
      {
        ...config,
        ingress: { mode: 'configured', publicUrl: 'https://app.example.com' },
      },
      ['frontend'],
      true,
    ),
  ).not.toThrow();
});
