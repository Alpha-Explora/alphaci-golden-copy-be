import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HeartbeatDto } from './onprem-host.dto';

const base = {
  agentVersion: '0.1.0',
  checks: [{ id: 'docker', status: 'passed', message: 'Docker is available.' }],
};
const errorsOf = async (value: Record<string, unknown>) =>
  validate(plainToInstance(HeartbeatDto, value));

describe('Machine heartbeat tunnel reports', () => {
  it('accepts heartbeats from older agents that send no tunnels', async () => {
    expect(await errorsOf(base)).toHaveLength(0);
  });
  it('accepts tunnel entries without rejecting the check-in, since the service records each entry on its own', async () => {
    // A malformed entry is recorded as a failed tunnel, not a 400 for the whole
    // heartbeat; that keeps the machine connected and its ports published.
    const entries = [
      { assignmentId: 'frontend', status: 'stopped', publicUrl: 42 },
      {
        assignmentId: '3f2b1c4e-5d6a-4b7c-8d9e-0f1a2b3c4d5e',
        status: 'running',
        message: 'Ready.',
        publicUrl: 'https://quiet-fox-blue-cloud.trycloudflare.com',
      },
    ];
    expect(await errorsOf({ ...base, tunnels: entries })).toHaveLength(0);
    expect(await errorsOf({ ...base, tunnels: [] })).toHaveLength(0);
  });
  it('rejects a tunnel list that is not an array, or is too long', async () => {
    expect(await errorsOf({ ...base, tunnels: 'running' })).not.toHaveLength(0);
    expect(
      await errorsOf({ ...base, tunnels: new Array(201).fill({}) }),
    ).not.toHaveLength(0);
  });
});
