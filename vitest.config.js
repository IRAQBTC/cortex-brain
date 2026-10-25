'use strict';

const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.git/**',
      '**/.idea/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/backups/**',
      '**/.cortex/**',
      '**/*.backup-*',
      '**/*.failed-*'
    ]
  }
});