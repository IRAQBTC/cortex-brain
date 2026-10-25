import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import dbPathConfig from './db-path.js';
import blastRadiusModule from "./blast-radius.js";
const { findBlastRadius } = blastRadiusModule;
const { DB_PATH } = dbPathConfig;

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`❌ Fatal: Cannot open database at ${DB_PATH}.`);
  process.exit(1);
}

const server = new Server(
  { name: "cortex-enterprise", version: "2.4.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_codebase",
        description: "Search for functions, classes, or files in the project based on a keyword using FTS5.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "The search term" } },
          required: ["query"]
        }
      },
      {
        name: "read_symbol",
        description: "Read the full source code of a specific function or class. You MUST provide both the name and the exact file_path.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The exact name of the function or class" },
            file_path: { type: "string", description: "The exact file path of the symbol" }
          },
          required: ["name", "file_path"]
        }
      },
      {
        name: "get_blast_radius",
        description: "Find statically resolved same-file direct-identifier caller candidates for a function or method. Supply file_path when the symbol name is ambiguous. Results are not runtime-verified and do not cover cross-file or member calls.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Exact function or method name" },
            file_path: { type: "string", description: "Optional exact indexed file path; recommended when names may repeat" }
          },
          required: ["name"]
        }
      },
      {
        name: "get_dependencies",
        description: "CRITICAL: Find all external modules or files that a specific file imports. Provide ONLY the file name (e.g., 'scanner.js'). Do NOT attempt to write SQL.",
        inputSchema: {
          type: "object",
          properties: { file_name: { type: "string", description: "The name of the file" } },
          required: ["file_name"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "search_codebase") {
      const searchQuery = args.query.split(' ').map(w => `${w}*`).join(' ');
      const stmt = db.prepare(`SELECT n.kind, n.name, n.file_path, n.signature FROM nodes_fts f JOIN nodes n ON f.rowid = n.rowid WHERE nodes_fts MATCH ? ORDER BY rank LIMIT 15`);
      return { content: [{ type: "text", text: JSON.stringify(stmt.all(searchQuery), null, 2) }] };
    }

    if (name === "read_symbol") {
      const filePath = args.file_path || args.filePath;
      const symbolName = args.name;

      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("Missing or invalid 'file_path' argument.");
      }
      if (typeof symbolName !== "string" || !symbolName.trim()) {
        throw new Error("Missing or invalid 'name' argument.");
      }

      const absolutePath = path.resolve(__dirname, filePath);
      const relativePath = path.relative(__dirname, absolutePath);

      if (
        relativePath === ".." ||
        relativePath.startsWith(".." + path.sep) ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error("Requested file is outside the Cortex project root.");
      }

      const cleanPath = relativePath.replace(/\\/g, "/");

      const node = db.prepare(`
        SELECT content, kind, file_path
        FROM nodes
        WHERE name = ?
          AND replace(file_path, char(92), '/') = ?
          AND kind IN ('function', 'method', 'class')
        LIMIT 1
      `).get(symbolName, cleanPath);

      if (!node) {
        throw new Error(
          `Symbol '${symbolName}' not found in exact project file '${cleanPath}'.`
        );
      }

      return {
        content: [{
          type: "text",
          text: `// Kind: ${node.kind}\n// File: ${node.file_path}\n\n${node.content}`
        }]
      };
    }

    if (name === "get_blast_radius") {
      const result = findBlastRadius(db, {
        name: args.name,
        file_path: args.file_path
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
    if (name === "get_dependencies") {
      const fileNode = db.prepare("SELECT file_path FROM nodes WHERE name = ? AND kind = 'file' LIMIT 1").get(args.file_name);
      if (!fileNode) throw new Error(`File '${args.file_name}' not found in the database.`);
      
      const imports = db.prepare("SELECT DISTINCT target FROM edges WHERE source = ? AND kind = 'imports'").all(fileNode.file_path);
      
      let msg = `Dependencies of '${args.file_name}' (${fileNode.file_path}):\n`;
      if (imports.length === 0) {
        msg += `This file does not import any other tracked modules. (Count: 0)`;
      } else {
        msg += `Found ${imports.length} import(s):\n`;
        imports.forEach(i => { msg += `- ${i.target}\n`; });
      }
      return { content: [{ type: "text", text: msg }] };
    }

    throw new Error(`Tool not found: ${name}`);
  } catch (error) {
    return { content: [{ type: "text", text: `Cortex Error: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("🧠 Cortex MCP Server v2.4 is running...");