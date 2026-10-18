# 🧠 Cortex - The Deterministic Project Brain

**Stop AI hallucinations. Give your AI the exact code it needs, not the whole project.**

Cortex is a local-first, high-performance tool that scans your codebase, builds a dependency graph, and provides verified context for AI agents (like Claude, GPT, or Cursor) with **zero hallucinations**.

## 🚀 Why Cortex?

- **⚡ Blazing Fast:** Powered by native SQLite (`better-sqlite3`), search results in <10ms.
- **🛡️ Zero Hallucinations:** Verify any symbol (function, class, file) before AI uses it. If it's not in the graph, it's not real.
- **💥 Blast Radius:** Before modifying a function, see exactly which other files will break.
- **🔌 Native MCP Support:** Connects directly to Claude Desktop and Cursor as an MCP server.
- **🔒 Local-First:** Your code never leaves your machine.

## 📦 Installation

```bash
npm install -g cortex-brain
🎯 Quick Start
Navigate to your project directory:

bash
cd /path/to/your/project
Scan your codebase (builds the AST graph):

bash
cortex scan
Start the Dashboard:

bash
cortex serve
Open your browser at http://localhost:3000.

🔌 MCP Integration (Claude Desktop / Cursor)
Add this to your claude_desktop_config.json or Cursor MCP settings:

json
{
  "mcpServers": {
    "cortex": {
      "command": "cortex",
      "args": ["mcp"]
    }
  }
}
🏗️ Architecture
Scanner: Uses tree-sitter to parse JavaScript/TypeScript into a precise AST.

Graph: Stores nodes (functions, classes, files) and edges (imports, defines) in SQLite.

Server: Express.js with Helmet, CORS, Rate Limiting, and Zod validation.

UI: Lightweight, keyboard-navigable dashboard with Prism.js syntax highlighting.

📄 License
MIT