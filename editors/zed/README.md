# Chant for Zed

Infrastructure-as-code toolkit — LSP integration for [chant](https://github.com/intentius/chant) projects in [Zed](https://zed.dev).

## Features

- **Completions** — resource types, properties, and intrinsics
- **Hover** — inline documentation for resources and properties
- **Diagnostics** — lint rules and type errors
- **Code actions** — quick fixes from chant lint rules

## Requirements

- A chant project (contains `chant.config.ts` or `chant.config.json`)
- The `chant` CLI on your PATH

## Installation

### From source (dev install)

```bash
cd editors/zed
rustup target add wasm32-wasip1
cargo build --release --target wasm32-wasip1
```

Then in Zed: Command Palette → "zed: Install Dev Extension" → select the `editors/zed/` directory.

## How it works

The extension detects chant projects by looking for `chant.config.ts` or `chant.config.json` in the workspace root. When found, it starts the language server via `chant serve lsp`.
