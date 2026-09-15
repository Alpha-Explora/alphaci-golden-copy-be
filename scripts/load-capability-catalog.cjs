'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

require('ts-node/register/transpile-only');

function loadCapabilityCatalog() {
  const registry = require(path.join(ROOT, 'src/kernel/composition/capability-registry.ts'));
  const manifests = require(path.join(ROOT, 'src/kernel/composition/manifests.ts'));

  return {
    capabilities: registry.CAPABILITIES,
    manifests: manifests.PACK_MANIFESTS,
  };
}

module.exports = { loadCapabilityCatalog };
