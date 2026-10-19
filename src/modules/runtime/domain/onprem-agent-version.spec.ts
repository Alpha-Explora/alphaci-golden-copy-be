import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ONPREM_AGENT_VERSION } from './onprem-agent-version';

const AGENT_DIR = join(__dirname, '../../../../deploy/onprem/agent');

describe('ONPREM_AGENT_VERSION', () => {
  it('matches the installer release manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(AGENT_DIR, 'release-manifest.json'), 'utf8'),
    ) as { version: string };

    expect(ONPREM_AGENT_VERSION).toBe(manifest.version);
  });

  it.each(['enroll.sh', 'alphaci-supervisor.sh'])(
    'matches the agentVersion %s reports',
    (file) => {
      const reported = [
        ...readFileSync(join(AGENT_DIR, file), 'utf8').matchAll(
          /agentVersion:"([^"]+)"/g,
        ),
      ].map((match) => match[1]);

      expect(reported.length).toBeGreaterThan(0);
      expect(new Set(reported)).toEqual(new Set([ONPREM_AGENT_VERSION]));
    },
  );
});
