import type { LexiconPlugin } from "../../lexicon";
import type { CompletionContext, HoverContext, CodeActionContext } from "../../lsp/types";
import { computeCapabilities } from "./capabilities";
import { toLspDiagnostics } from "./diagnostics";

/**
 * JSON-RPC message types
 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/**
 * stdio LSP server using Content-Length framing.
 * Delegates completions, hover, and code actions to lexicon plugins.
 */
export class LspServer {
  private plugins: LexiconPlugin[];
  openDocuments: Map<string, string> = new Map();
  private buffer = "";
  /** Captured notifications for testing — only populated when captureNotifications is true */
  sentNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  private captureNotifications = false;

  constructor(plugins: LexiconPlugin[], options?: { captureNotifications?: boolean }) {
    this.plugins = plugins;
    this.captureNotifications = options?.captureNotifications ?? false;
  }

  /**
   * Start reading from stdin with Content-Length framing
   */
  async start(): Promise<void> {
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.processBuffer();
    });
  }

  /**
   * Process the incoming buffer, extracting complete messages
   */
  private processBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed header
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) break; // Wait for more data

      const body = this.buffer.slice(messageStart, messageEnd);
      this.buffer = this.buffer.slice(messageEnd);

      try {
        const message = JSON.parse(body);
        if ("id" in message) {
          this.handleRequest(message as JsonRpcRequest);
        } else {
          this.handleNotification(message as JsonRpcNotification);
        }
      } catch {
        // Ignore malformed JSON
      }
    }
  }

  /**
   * Send a request and return the response directly (for testing).
   */
  async sendRequest(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    try {
      const result = await this.dispatch(method, params ?? {});
      return { jsonrpc: "2.0", id: 0, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: 0,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * Handle a JSON-RPC request (has id, expects response)
   */
  async handleRequest(request: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.dispatch(request.method, request.params ?? {});
      this.sendResponse({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      this.sendResponse({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * Handle a JSON-RPC notification (no id, no response).
   * Public to allow direct testing without stdio.
   */
  handleNotification(notification: JsonRpcNotification): void {
    switch (notification.method) {
      case "initialized":
        // Client acknowledged initialization
        break;

      case "textDocument/didOpen": {
        const params = notification.params as {
          textDocument: { uri: string; text: string };
        };
        this.openDocuments.set(params.textDocument.uri, params.textDocument.text);
        this.publishDiagnostics(params.textDocument.uri, params.textDocument.text);
        break;
      }

      case "textDocument/didChange": {
        const params = notification.params as {
          textDocument: { uri: string };
          contentChanges: Array<{ text: string }>;
        };
        // Full sync: take the last content change
        const text = params.contentChanges[params.contentChanges.length - 1]?.text ?? "";
        this.openDocuments.set(params.textDocument.uri, text);
        this.publishDiagnostics(params.textDocument.uri, text);
        break;
      }

      case "textDocument/didClose": {
        const params = notification.params as {
          textDocument: { uri: string };
        };
        this.openDocuments.delete(params.textDocument.uri);
        // Clear diagnostics for closed document
        this.sendNotification("textDocument/publishDiagnostics", {
          uri: params.textDocument.uri,
          diagnostics: [],
        });
        break;
      }
    }
  }

  /**
   * Dispatch request to appropriate handler
   */
  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.handleInitialize();

      case "textDocument/completion":
        return this.handleCompletion(params);

      case "textDocument/hover":
        return this.handleHover(params);

      case "textDocument/codeAction":
        return this.handleCodeAction(params);

      case "textDocument/diagnostic":
        return this.handleDiagnostic(params);

      case "shutdown":
        return null;

      default:
        return null;
    }
  }

  /**
   * Handle initialize request
   */
  private handleInitialize(): unknown {
    return {
      capabilities: computeCapabilities(this.plugins),
      serverInfo: {
        name: "chant",
        version: "0.1.0",
      },
    };
  }

  /**
   * Handle textDocument/completion
   */
  private handleCompletion(params: Record<string, unknown>): unknown {
    const textDocument = params.textDocument as { uri: string };
    const position = params.position as { line: number; character: number };
    const content = this.openDocuments.get(textDocument.uri) ?? "";

    const lines = content.split("\n");
    const line = lines[position.line] ?? "";
    const linePrefix = line.slice(0, position.character);

    // Extract word at cursor
    const wordMatch = linePrefix.match(/(\w+)$/);
    const wordAtCursor = wordMatch?.[1] ?? "";

    const ctx: CompletionContext = {
      uri: textDocument.uri,
      content,
      position,
      wordAtCursor,
      linePrefix,
    };

    const items = [];
    for (const plugin of this.plugins) {
      if (plugin.completionProvider) {
        items.push(...plugin.completionProvider(ctx));
      }
    }

    return { isIncomplete: false, items };
  }

  /**
   * Handle textDocument/hover
   */
  private handleHover(params: Record<string, unknown>): unknown {
    const textDocument = params.textDocument as { uri: string };
    const position = params.position as { line: number; character: number };
    const content = this.openDocuments.get(textDocument.uri) ?? "";

    const lines = content.split("\n");
    const lineText = lines[position.line] ?? "";

    // Extract word at position
    let start = position.character;
    let end = position.character;
    while (start > 0 && /\w/.test(lineText[start - 1])) start--;
    while (end < lineText.length && /\w/.test(lineText[end])) end++;
    const word = lineText.slice(start, end);

    const ctx: HoverContext = {
      uri: textDocument.uri,
      content,
      position,
      word,
      lineText,
    };

    // First plugin to return info wins
    for (const plugin of this.plugins) {
      if (plugin.hoverProvider) {
        const info = plugin.hoverProvider(ctx);
        if (info) {
          return {
            contents: { kind: "markdown", value: info.contents },
            range: info.range,
          };
        }
      }
    }

    return null;
  }

  /**
   * Handle textDocument/codeAction
   */
  private handleCodeAction(params: Record<string, unknown>): unknown {
    const textDocument = params.textDocument as { uri: string };
    const range = params.range as { start: { line: number; character: number }; end: { line: number; character: number } };
    const context = params.context as { diagnostics?: Array<{ code?: string; message: string; range: unknown; severity?: number }> } | undefined;
    const content = this.openDocuments.get(textDocument.uri) ?? "";

    const ctx: CodeActionContext = {
      uri: textDocument.uri,
      content,
      range,
      diagnostics: (context?.diagnostics ?? []).map((d) => ({
        range: d.range as CodeActionContext["diagnostics"][0]["range"],
        message: d.message,
        ruleId: typeof d.code === "string" ? d.code : undefined,
        severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
      })),
    };

    const actions = [];
    for (const plugin of this.plugins) {
      if (plugin.codeActionProvider) {
        actions.push(...plugin.codeActionProvider(ctx));
      }
    }

    return actions;
  }

  /**
   * Handle textDocument/diagnostic (pull model)
   */
  private async handleDiagnostic(params: Record<string, unknown>): Promise<unknown> {
    const textDocument = params.textDocument as { uri: string };
    const content = this.openDocuments.get(textDocument.uri) ?? "";
    const diagnostics = await this.computeDiagnostics(textDocument.uri, content);
    return { kind: "full", items: diagnostics };
  }

  /**
   * Publish diagnostics for a document (push model)
   */
  private async publishDiagnostics(uri: string, content: string): Promise<void> {
    const diagnostics = await this.computeDiagnostics(uri, content);
    this.sendNotification("textDocument/publishDiagnostics", {
      uri,
      diagnostics,
    });
  }

  /**
   * Run lint engine and convert to LSP diagnostics
   */
  private async computeDiagnostics(uri: string, content: string): Promise<unknown[]> {
    // Only lint .ts files
    const filePath = uri.startsWith("file://") ? uri.slice(7) : uri;
    if (!filePath.endsWith(".ts")) return [];

    try {
      const { runLint } = await import("../../lint/engine");
      const rules = [];
      for (const plugin of this.plugins) {
        rules.push(...(plugin.lintRules?.() ?? []));
      }

      if (rules.length === 0) return [];

      const diagnostics = await runLint([filePath], rules);
      return toLspDiagnostics(diagnostics);
    } catch {
      return [];
    }
  }

  /**
   * Send a JSON-RPC response with Content-Length framing
   */
  private sendResponse(response: JsonRpcResponse): void {
    const body = JSON.stringify(response);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    process.stdout.write(header + body);
  }

  /**
   * Send a JSON-RPC notification with Content-Length framing
   */
  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (this.captureNotifications) {
      this.sentNotifications.push({ method, params });
      return;
    }
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    process.stdout.write(header + body);
  }
}
