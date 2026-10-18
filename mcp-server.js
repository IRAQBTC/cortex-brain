'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.CORTEX_DB_PATH || path.join(__dirname, 'cortex-brain.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`❌ Fatal: Database not found at ${DB_PATH}. Run "cortex scan" first.`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('journal_mode = WAL');

const server = new Server(
  { name: 'cortex-brain', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'cortex_search',
        description: 'Search the project codebase for functions, classes, or files.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
            limit: { type: 'number', description: 'Max results', default: 10 },
          },
          required: ['query'],
        },
      },
      {
        name: 'cortex_verify',
        description: 'Verify if a symbol exists in a specific file.',
        inputSchema: {
          type: 'object',
          properties: {
            symbolName: { type: 'string', description: 'The symbol name' },
            filePath: { type: 'string', description: 'The file path' },
            symbolType: { type: 'string', enum: ['function', 'class', 'method', 'variable', 'import'] },
          },
          required: ['symbolName', 'filePath', 'symbolType'],
        },
      },
      {
        name: 'cortex_blast_radius',
        description: 'Check which files will be affected if you modify a function.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The symbol name' },
            filePath: { type: 'string', description: 'The file path' },
          },
          required: ['name', 'filePath'],
        },
      },
      {
        name: 'cortex_get_code',
        description: 'Get the full code of a function or class.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The symbol name' },
            filePath: { type: 'string', description: 'The file path' },
            kind: { type: 'string', enum: ['function', 'class', 'method', 'file'] },
          },
          required: ['name', 'filePath'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'cortex_search') {
      const query = (args.query || '').toLowerCase();
      const limit = Math.min(args.limit || 10, 50);
      const stmt = db.prepare(`SELECT kind, name, file_path, signature FROM nodes WHERE LOWER(name) LIKE @query ORDER BY CASE WHEN LOWER(name) = @exact THEN 0 ELSE 1 END, name ASC LIMIT @limit`);
      const results = stmt.all({ query: `%${query}%`, exact: query, limit });
      if (results.length === 0) return { content: [{ type: 'text', text: `🔍 No results found for "${args.query}".` }] };
      const text = results.map(r => `- [${r.kind.toUpperCase()}] **${r.name}** (\`${r.file_path}\`)\n  Signature: \`${r.signature || 'N/A'}\``).join('\n\n');
      return { content: [{ type: 'text', text: `✅ Found ${results.length} result(s):\n\n${text}` }] };
    }
    if (name === 'cortex_verify') {
      const stmt = db.prepare(`SELECT kind FROM nodes WHERE name = @name AND file_path = @path AND kind = @type LIMIT 1`);
      const result = stmt.get({ name: args.symbolName, path: args.filePath, type: args.symbolType });
      if (result) return { content: [{ type: 'text', text: `✅ VERIFIED: "${args.symbolName}" exists.` }] };
      return { content: [{ type: 'text', text: `❌ REFUTED: "${args.symbolName}" does NOT exist. Hallucination detected.` }] };
    }
    if (name === 'cortex_blast_radius') {
      const stmt = db.prepare(`SELECT DISTINCT n_source.file_path AS affected_file FROM nodes n_target JOIN edges e_def ON n_target.id = e_def.target_id AND e_def.kind = 'defines' JOIN nodes n_file ON e_def.source_id = n_file.id JOIN edges e_imp ON n_file.id = e_imp.target_id AND e_imp.kind = 'imports_internal' JOIN nodes n_source ON e_imp.source_id = n_source.id WHERE n_target.name = @name AND n_target.file_path = @path`);
      const affected = stmt.all({ name: args.name, path: args.filePath });
      if (affected.length === 0) return { content: [{ type: 'text', text: `✅ SAFE: No files depend on "${args.name}".` }] };
      return { content: [{ type: 'text', text: `⚠️ WARNING: ${affected.length} file(s) depend on "${args.name}":\n\n${affected.map(f => `- \`${f.affected_file}\``).join('\n')}` }] };
    }
    if (name === 'cortex_get_code') {
      let sql = "SELECT content, kind FROM nodes WHERE name = @name AND file_path = @path LIMIT 1";
      const params = { name: args.name, path: args.filePath };
      if (args.kind) { sql = "SELECT content, kind FROM nodes WHERE name = @name AND file_path = @path AND kind = @kind LIMIT 1"; params.kind = args.kind; }
      const stmt = db.prepare(sql);
      const result = stmt.get(params);
      if (!result || !result.content) return { content: [{ type: 'text', text: `❌ NOT FOUND.` }] };
      return { content: [{ type: 'text', text: `📄 Code for \`${args.name}\`:\n\n\`\`\`javascript\n${result.content}\n\`\`\`` }] };
    }
    return { content: [{ type: 'text', text: `❌ Unknown tool.` }], isError: true };
  } catch (error) {
    return { content: [{ type: 'text', text: `❌ Error: ${error.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🧠 Cortex MCP Server ready.');
}
main().catch(console.error);

