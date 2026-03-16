import * as path from "path";
import * as fs from "fs";
import {
  workspace,
  window,
  StatusBarAlignment,
  ExtensionContext,
  StatusBarItem,
} from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
} from "vscode-languageclient/node";
import { execSync } from "child_process";

let client: LanguageClient | undefined;
let statusBar: StatusBarItem;

export async function activate(context: ExtensionContext): Promise<void> {
  const config = workspace.getConfiguration("chant");
  if (!config.get<boolean>("enable", true)) {
    return;
  }

  // Verify this is a chant project
  const configFiles = await workspace.findFiles(
    "**/chant.config.{ts,json}",
    "**/node_modules/**",
    1
  );
  if (configFiles.length === 0) {
    return;
  }

  // Resolve binary path
  const binary = resolveBinary(config.get<string>("server.path", "chant"));
  if (!binary) {
    window.showWarningMessage(
      "Chant: could not find the chant CLI. Install it or set chant.server.path."
    );
    return;
  }

  const args = config.get<string[]>("server.args", ["serve", "lsp"]);

  // Status bar
  statusBar = window.createStatusBarItem(StatusBarAlignment.Left, 0);
  statusBar.text = "$(gear~spin) Chant";
  statusBar.tooltip = "Chant Language Server starting...";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // LSP client
  const serverOptions: ServerOptions = {
    command: binary,
    args,
    options: {
      env: { ...process.env },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "typescript" }],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher(
        "**/chant.config.{ts,json}"
      ),
    },
  };

  client = new LanguageClient(
    "chant",
    "Chant Language Server",
    serverOptions,
    clientOptions
  );

  client.onDidChangeState((e) => {
    if (e.newState === State.Running) {
      statusBar.text = "$(check) Chant";
      statusBar.tooltip = "Chant Language Server running";
    } else if (e.newState === State.Stopped) {
      statusBar.text = "$(x) Chant";
      statusBar.tooltip = "Chant Language Server stopped";
    }
  });

  context.subscriptions.push(client);
  await client.start();

  // Register MCP server config
  registerMcpConfig(binary);
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
  }
}

function resolveBinary(configured: string): string | undefined {
  // 1. If user set an absolute/custom path, use it directly
  if (configured !== "chant") {
    return configured;
  }

  // 2. Check workspace node_modules/.bin/chant
  const folders = workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const localBin = path.join(
      folders[0].uri.fsPath,
      "node_modules",
      ".bin",
      "chant"
    );
    if (fs.existsSync(localBin)) {
      return localBin;
    }
  }

  // 3. Check PATH
  try {
    const resolved = execSync("which chant", { encoding: "utf-8" }).trim();
    if (resolved) {
      return resolved;
    }
  } catch {
    // not on PATH
  }

  return undefined;
}

function registerMcpConfig(binary: string): void {
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return;
  }

  const vscodeDir = path.join(folders[0].uri.fsPath, ".vscode");
  const mcpPath = path.join(vscodeDir, "mcp.json");

  // Read existing config or start fresh
  let mcpConfig: Record<string, unknown> = {};
  if (fs.existsSync(mcpPath)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    } catch {
      return; // Don't overwrite a malformed file
    }
  }

  const servers = (mcpConfig.servers ?? {}) as Record<string, unknown>;

  // Don't overwrite if user already has a chant entry
  if ("chant" in servers) {
    return;
  }

  servers.chant = {
    type: "stdio",
    command: binary,
    args: ["serve", "mcp"],
  };
  mcpConfig.servers = servers;

  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir, { recursive: true });
  }
  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
}
