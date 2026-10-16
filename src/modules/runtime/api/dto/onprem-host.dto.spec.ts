import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HeartbeatDto } from './onprem-host.dto';

const assignmentId = '3f2b1c4e-5d6a-4b7c-8d9e-0f1a2b3c4d5e';
const base = {
  agentVersion: '0.1.0',
  checks: [{ id: 'docker', status: 'passed', message: 'Docker is available.' }],
};
const tunnel = (overrides: Record<string, unknown> = {}) => ({
  assignmentId,
  status: 'running',
  message: 'Automatic HTTPS address is ready.',
  publicUrl: 'https://quiet-fox-blue-cloud.trycloudflare.com',
  ...overrides,
});
const errorsOf = async (value: Record<string, unknown>) =>
  validate(plainToInstance(HeartbeatDto, value));

describe('Machine heartbeat tunnel reports', () => {
  it('accepts heartbeats from older agents that send no tunnels', async () => {
    expect(await errorsOf(base)).toHaveLength(0);
  });
  it('accepts running, starting, unavailable, and failed reports', async () => {
    for (const report of [
      tunnel(),
      tunnel({ status: 'starting', publicUrl: null }),
      tunnel({
        status: 'unavailable',
        publicUrl: null,
        message: 'Install cloudflared.',
      }),
      tunnel({ status: 'failed', publicUrl: null }),
    ])
      expect(await errorsOf({ ...base, tunnels: [report] })).toHaveLength(0);
    expect(await errorsOf({ ...base, tunnels: [] })).toHaveLength(0);
  });
  it.each([
    ['a non-HTTPS address', { publicUrl: 'http://quiet.trycloudflare.com' }],
    [
      'an address with a path',
      { publicUrl: 'https://quiet.trycloudflare.com/app' },
    ],
    [
      'an address with credentials',
      { publicUrl: 'https://user:pw@quiet.trycloudflare.com' },
    ],
    ['an unknown status', { status: 'stopped' }],
    ['an assignment id that is not a UUID', { assignmentId: 'frontend' }],
    ['a message longer than 300 characters', { message: 'x'.repeat(301) }],
    ['a missing publicUrl key', { publicUrl: undefined }],
  ])('rejects %s', async (_name, override) => {
    expect(
      await errorsOf({ ...base, tunnels: [tunnel(override)] }),
    ).not.toHaveLength(0);
  });
});
