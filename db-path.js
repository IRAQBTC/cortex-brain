'use strict';

const path = require('node:path');
require('dotenv').config({
  quiet: true,
  path: path.join(__dirname, '.env')
});

const configuredPath =
  process.env.CORTEX_DB_PATH ||
  process.env.DB_PATH ||
  'cortex-brain.db';

const DB_PATH = path.isAbsolute(configuredPath)
  ? path.normalize(configuredPath)
  : path.resolve(__dirname, configuredPath);

module.exports = { DB_PATH };