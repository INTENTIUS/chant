# Chant for VS Code

Infrastructure-as-code toolkit — LSP integration for [chant](https://github.com/intentius/chant) projects.

Also works in [Cursor](https://cursor.sh) (VS Code fork).

## Features

- **Completions** — resource types, properties, and intrinsics
- **Hover** — inline documentation for resources and properties
- **Diagnostics** — lint rules and type errors
- **Code actions** — quick fixes from chant lint rules
- **MCP registration** — auto-configures `.vscode/mcp.json` for AI agent integration

## Requirements

- A chant project (contains `chant.config.ts` or `chant.config.json`)
- The `chant` CLI installed locally (`npm install @intentius/chant`) or globally

## Settings

| Setting | Default | Description |
|---|---|---|
| `chant.server.path` | `"chant"` | Path to the chant CLI binary |
| `chant.server.args` | `["serve", "lsp"]` | Arguments passed to start the LSP server |
| `chant.enable` | `true` | Enable the Chant language server |

## Binary Resolution

The extension finds the chant CLI in this order:

1. `chant.server.path` setting (if user-configured)
2. `{workspaceFolder}/node_modules/.bin/chant`
3. `chant` on PATH

## Development

```bash
cd editors/vscode
npm install
npm run build    # one-shot build
npm run watch    # rebuild on change
npm run package  # produce .vsix
```

Press F5 in VS Code to launch an Extension Development Host for testing.
