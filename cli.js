#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const command = process.argv[2];
const args = process.argv.slice(3).join(' ');
const scriptDir = __dirname;

try {
  switch (command) {
    case 'scan':
      console.log('🧠 Starting Cortex AST Scanner...');
      execSync(`node "${path.join(scriptDir, 'scanner.js')}"`, { stdio: 'inherit' });
      break;
    case 'serve':
    case 'start':
      console.log('🚀 Starting Cortex Dashboard Server...');
      execSync(`node "${path.join(scriptDir, 'server.js')}"`, { stdio: 'inherit' });
      break;
    case 'mcp':
      console.log('🔌 Starting Cortex MCP Server...');
      execSync(`node "${path.join(scriptDir, 'mcp-server.mjs')}"`, { stdio: 'inherit' });
      break;
    case 'ask':
      if (!args) {
        console.error('❌ Please provide a question. Example: cortex ask "scan"');
        process.exit(1);
      }
      execSync(`node "${path.join(scriptDir, 'ask.js')}" "${args}"`, { stdio: 'inherit' });
      break;
    case 'verify':
      execSync(`node "${path.join(scriptDir, 'verify.js')}" ${args}`, { stdio: 'inherit' });
      break;
    case '--help':
    case '-h':
    case undefined:
      console.log(`
🧠 Cortex CLI - The Deterministic Project Brain

Usage:
  cortex scan       Build the AST graph and dependency edges (creates cortex-brain.db)
  cortex serve      Start the local Dashboard and API server (http://localhost:3000)
  cortex mcp        Start the MCP server for Claude Desktop / Cursor integration
  cortex ask "<q>"  Search the codebase from terminal
  cortex verify ... Run verification gate
  cortex --help     Show this help message
      `);
      break;
    default:
      console.error(`❌ Unknown command: ${command}`);
      console.log('Run "cortex --help" for usage information.');
      process.exit(1);
  }
} catch (error) {
  console.error(`\n💥 Command failed: ${error.message}`);
  process.exit(1);
}