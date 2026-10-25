# 🧠 Cortex Enterprise - The Deterministic Project Brain

**Stop AI hallucinations. Give your AI the exact code it needs, not the whole project.**

Cortex is a local-first, high-performance code intelligence platform that scans your codebase, builds a dependency graph, and provides verified context for AI agents (like Claude, GPT, or Cursor) with **zero hallucinations**.

## 🚀 Why Cortex Enterprise?

- **⚡ Blazing Fast:** Powered by native SQLite (`better-sqlite3`), search results in <10ms.
- **🛡️ Zero Hallucinations:** Verify any symbol (function, class, file) before AI uses it. If it's not in the graph, it's not real.
- **💥 Blast Radius:** Before modifying a function, see exactly which other files will break.
- **🕸️ Interactive Dependency Map:** A visual graph of your entire codebase.
- **🐍 Multi-Language Support:** Powered by `tree-sitter` for accurate AST parsing of JavaScript, TypeScript, and **Python**.
- **🕵️ Dead Code & Security Audits:** Detect unused code and heuristic security vulnerabilities.
- **📦 AI Context Exporter:** Export perfectly formatted Markdown code blocks to paste directly into Claude or ChatGPT.
- **🔌 Native MCP Support:** Connects directly to Claude Desktop and Cursor as an MCP server.
- **🔒 Local-First:** Your code never leaves your machine.

## 📦 Installation

```bash
npm install -g @almosawy/cortex-brain
🎯 Quick Start
Go to your project directory:

bash
cd /path/to/your/project
Scan your codebase (builds the AST graph):

bash
cortex scan
Start the Enterprise Dashboard:

bash
cortex serve
Open your browser at http://localhost:3000.

🛠️ CLI Commands
cortex scan - Build the AST graph, dependency edges, and call graph.

cortex serve - Start the Cortex Enterprise Dashboard (API + UI).

cortex ask "<query>" - Search the codebase from terminal.

cortex verify <type> <name> [file] - Verify if a symbol exists.

cortex context - Generate AI context (Markdown) for the project.

cortex mcp - Start the MCP server for Claude Desktop / Cursor integration.

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
Scanner: Uses tree-sitter to parse JavaScript/TypeScript/Python into a precise AST.

Graph: Stores nodes (functions, classes, files), edges (imports, defines), and call-graphs in SQLite.

Server: Express.js with Helmet, CORS, Rate Limiting, and Zod validation.

UI: Enterprise dashboard with Dependency Map (D3.js/Canvas), Syntax Highlighting, and Impact Analysis.

📄 License
MI