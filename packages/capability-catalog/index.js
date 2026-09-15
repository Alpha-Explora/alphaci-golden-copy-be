/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const catalog = require('./catalog.json');
const manifests = require('./manifests.json');
const { version } = require('./package.json');

module.exports = Object.freeze({
  version,
  catalog: Object.freeze(catalog),
  manifests: Object.freeze(manifests),
});
