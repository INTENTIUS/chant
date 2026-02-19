import { describe, test, expect, beforeEach } from "bun:test";
import { LspServer } from "./server";
import { computeCapabilities } from "./capabilities";
import { toLspDiagnostics } from "./diagnostics";
import type { LexiconPlugin } from "../../lexicon";
import type { Serializer } from "../../serializer";
import type { CompletionContext, HoverContext, CodeActionContext, CompletionItem, HoverInfo, CodeAction } from "../../lsp/types";

function createMockPlugin(overrides?: Partial<LexiconPlugin>): LexiconPlugin {
  return {
    name: "mock",
    serializer: { name: "mock", serialize: () => "" } as unknown as Serializer,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

describe("computeCapabilities", () => {
  test("always includes textDocumentSync and diagnosticProvider", () => {
    const caps = computeCapabilities([]);
    expect(caps.textDocumentSync).toBe(1);
    expect(caps.diagnosticProvider).toBeDefined();
  });

  test("advertises completionProvider when any plugin provides it", () => {
    const caps = computeCapabilities([
      createMockPlugin({ completionProvider: () => [] }),
    ]);
    expect(caps.completionProvider).toBeDefined();
    expect(caps.completionProvider!.triggerCharacters.length).toBeGreaterThan(0);
  });

  test("omits completionProvider when no plugin provides it", () => {
    const caps = computeCapabilities([createMockPlugin()]);
    expect(caps.completionProvider).toBeUndefined();
  });

  test("advertises hoverProvider when plugin provides it", () => {
    const caps = computeCapabilities([
      createMockPlugin({ hoverProvider: () => ({ contents: "hi" }) }),
    ]);
    expect(caps.hoverProvider).toBe(true);
  });

  test("omits hoverProvider when no plugin provides it", () => {
    const caps = computeCapabilities([createMockPlugin()]);
    expect(caps.hoverProvider).toBeUndefined();
  });

  test("advertises codeActionProvider when plugin provides it", () => {
    const caps = computeCapabilities([
      createMockPlugin({ codeActionProvider: () => [] }),
    ]);
    expect(caps.codeActionProvider).toBe(true);
  });

  test("omits codeActionProvider when no plugin provides it", () => {
    const caps = computeCapabilities([createMockPlugin()]);
    expect(caps.codeActionProvider).toBeUndefined();
  });

  test("combines capabilities from multiple plugins", () => {
    const caps = computeCapabilities([
      createMockPlugin({ completionProvider: () => [] }),
      createMockPlugin({ hoverProvider: () => ({ contents: "x" }) }),
    ]);
    expect(caps.completionProvider).toBeDefined();
    expect(caps.hoverProvider).toBe(true);
    expect(caps.codeActionProvider).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// diagnostics conversion
// ---------------------------------------------------------------------------

describe("toLspDiagnostics", () => {
  test("converts lint diagnostic to LSP format (1-based to 0-based)", () => {
    const result = toLspDiagnostics([
      { file: "a.ts", line: 5, column: 3, ruleId: "R001", severity: "warning", message: "bad" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].range.start.line).toBe(4);
    expect(result[0].range.start.character).toBe(2);
    expect(result[0].severity).toBe(2);
    expect(result[0].code).toBe("R001");
    expect(result[0].source).toBe("chant");
    expect(result[0].message).toBe("bad");
  });

  test("maps error severity to 1", () => {
    const [d] = toLspDiagnostics([
      { file: "a.ts", line: 1, column: 1, ruleId: "R", severity: "error", message: "" },
    ]);
    expect(d.severity).toBe(1);
  });

  test("maps info severity to 3", () => {
    const [d] = toLspDiagnostics([
      { file: "a.ts", line: 1, column: 1, ruleId: "R", severity: "info", message: "" },
    ]);
    expect(d.severity).toBe(3);
  });

  test("clamps negative line/column to 0", () => {
    const [d] = toLspDiagnostics([
      { file: "a.ts", line: 0, column: 0, ruleId: "R", severity: "error", message: "" },
    ]);
    expect(d.range.start.line).toBe(0);
    expect(d.range.start.character).toBe(0);
  });

  test("includes fix data when fix is present", () => {
    const fix = { range: [10, 20] as [number, number], replacement: "x" };
    const [d] = toLspDiagnostics([
      { file: "a.ts", line: 1, column: 1, ruleId: "R", severity: "error", message: "", fix },
    ]);
    expect(d.data?.fix).toBeDefined();
    expect(d.data?.ruleId).toBe("R");
  });

  test("omits fix data when no fix", () => {
    const [d] = toLspDiagnostics([
      { file: "a.ts", line: 1, column: 1, ruleId: "R", severity: "error", message: "" },
    ]);
    expect(d.data?.fix).toBeUndefined();
    expect(d.data?.ruleId).toBe("R");
  });

  test("converts multiple diagnostics", () => {
    const result = toLspDiagnostics([
      { file: "a.ts", line: 1, column: 1, ruleId: "A", severity: "error", message: "one" },
      { file: "a.ts", line: 10, column: 5, ruleId: "B", severity: "warning", message: "two" },
      { file: "b.ts", line: 3, column: 2, ruleId: "C", severity: "info", message: "three" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0].code).toBe("A");
    expect(result[1].range.start.line).toBe(9);
    expect(result[2].severity).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// LspServer — request dispatch
// ---------------------------------------------------------------------------

describe("LspServer", () => {
  let server: LspServer;

  describe("initialize", () => {
    test("returns capabilities and serverInfo", async () => {
      const plugin = createMockPlugin({ completionProvider: () => [] });
      server = new LspServer([plugin], { captureNotifications: true });
      const res = await server.sendRequest("initialize");

      expect(res.error).toBeUndefined();
      const result = res.result as Record<string, unknown>;
      expect((result.serverInfo as Record<string, unknown>).name).toBe("chant");
      const caps = result.capabilities as Record<string, unknown>;
      expect(caps.textDocumentSync).toBe(1);
      expect(caps.completionProvider).toBeDefined();
    });

    test("capabilities reflect loaded plugins", async () => {
      server = new LspServer([], { captureNotifications: true });
      const res = await server.sendRequest("initialize");
      const caps = (res.result as Record<string, unknown>).capabilities as Record<string, unknown>;
      expect(caps.completionProvider).toBeUndefined();
      expect(caps.hoverProvider).toBeUndefined();
    });
  });

  describe("shutdown", () => {
    test("returns null", async () => {
      server = new LspServer([], { captureNotifications: true });
      const res = await server.sendRequest("shutdown");
      expect(res.result).toBeNull();
      expect(res.error).toBeUndefined();
    });
  });

  describe("unknown method", () => {
    test("returns null for unknown method", async () => {
      server = new LspServer([], { captureNotifications: true });
      const res = await server.sendRequest("textDocument/unknown");
      expect(res.result).toBeNull();
      expect(res.error).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Document synchronization
  // -----------------------------------------------------------------------

  describe("textDocument/didOpen", () => {
    test("stores document content", () => {
      server = new LspServer([], { captureNotifications: true });
      server.handleNotification({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///a.ts", text: "const x = 1;" } },
      });
      expect(server.openDocuments.get("file:///a.ts")).toBe("const x = 1;");
    });

    test("emits publishDiagnostics notification", async () => {
      server = new LspServer([], { captureNotifications: true });
      server.handleNotification({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///a.ts", text: "const x = 1;" } },
      });
      // Give async diagnostics time to emit
      await new Promise((r) => setTimeout(r, 50));
      const diagNotif = server.sentNotifications.find(
        (n) => n.method === "textDocument/publishDiagnostics",
      );
      expect(diagNotif).toBeDefined();
      expect(diagNotif!.params.uri).toBe("file:///a.ts");
    });
  });

  describe("textDocument/didChange", () => {
    test("updates document content", () => {
      server = new LspServer([], { captureNotifications: true });
      server.handleNotification({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///a.ts", text: "old" } },
      });
      server.handleNotification({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: { uri: "file:///a.ts" },
          contentChanges: [{ text: "new content" }],
        },
      });
      expect(server.openDocuments.get("file:///a.ts")).toBe("new content");
    });

    test("uses last content change on full sync", () => {
      server = new LspServer([], { captureNotifications: true });
      server.handleNotification({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///a.ts", text: "orig" } },
      });
      server.handleNotification({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: { uri: "file:///a.ts" },
          contentChanges: [{ text: "partial" }, { text: "final" }],
        },
      });
      expect(server.openDocuments.get("file:///a.ts")).toBe("final");
    });
  });

  describe("textDocument/didClose", () => {
    test("removes document and clears diagnostics", async () => {
      server = new LspServer([], { captureNotifications: true });
      server.handleNotification({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///a.ts", text: "x" } },
      });
      expect(server.openDocuments.has("file:///a.ts")).toBe(true);

      server.sentNotifications = [];
      server.handleNotification({
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri: "file:///a.ts" } },
      });
      expect(server.openDocuments.has("file:///a.ts")).toBe(false);

      const clearNotif = server.sentNotifications.find(
        (n) => n.method === "textDocument/publishDiagnostics",
      );
      expect(clearNotif).toBeDefined();
      expect(clearNotif!.params.diagnostics).toEqual([]);
    });
  });

  describe("initialized", () => {
    test("handles initialized notification without error", () => {
      server = new LspServer([], { captureNotifications: true });
      // Should not throw
      server.handleNotification({ jsonrpc: "2.0", method: "initialized" });
    });
  });

  // -----------------------------------------------------------------------
  // Completion
  // -----------------------------------------------------------------------

  describe("textDocument/completion", () => {
    test("returns items from plugin completionProvider", async () => {
      const items: CompletionItem[] = [
        { label: "Bucket", kind: "resource", detail: "AWS::S3::Bucket" },
        { label: "Table", kind: "resource", detail: "AWS::DynamoDB::Table" },
      ];
      const plugin = createMockPlugin({
        completionProvider: () => items,
      });
      server = new LspServer([plugin], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "const b = new B");

      const res = await server.sendRequest("textDocument/completion", {
        textDocument: { uri: "file:///a.ts" },
        position: { line: 0, character: 15 },
      });

      const result = res.result as { isIncomplete: boolean; items: CompletionItem[] };
      expect(result.isIncomplete).toBe(false);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].label).toBe("Bucket");
    });

    test("aggregates completions from multiple plugins", async () => {
      const plugin1 = createMockPlugin({
        name: "alpha",
        completionProvider: () => [{ label: "AlphaItem" }],
      });
      const plugin2 = createMockPlugin({
        name: "beta",
        completionProvider: () => [{ label: "BetaItem" }],
      });
      server = new LspServer([plugin1, plugin2], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "x");

      const res = await server.sendRequest("textDocument/completion", {
        textDocument: { uri: "file:///a.ts" },
        position: { line: 0, character: 1 },
      });

      const result = res.result as { items: CompletionItem[] };
      expect(result.items).toHaveLength(2);
      expect(result.items.map((i) => i.label)).toContain("AlphaItem");
      expect(result.items.map((i) => i.label)).toContain("BetaItem");
    });

    test("returns empty items when no plugins have completionProvider", async () => {
      server = new LspServer([createMockPlugin()], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "x");

      const res = await server.sendRequest("textDocument/completion", {
        textDocument: { uri: "file:///a.ts" },
        position: { line: 0, character: 1 },
      });

      const result = res.result as { items: CompletionItem[] };
      expect(result.items).toHaveLength(0);
    });

    test("extracts wordAtCursor and linePrefix correctly", async () => {
      let capturedCtx: CompletionContext | undefined;
      const plugin = createMockPlugin({
        completionProvider: (ctx) => {
          capturedCtx = ctx;
          return [];
        },
      });
      server = new LspServer([plugin], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "const bucket = new Buck");

      await server.sendRequest("textDocument/completion", {
        textDocument: { uri: "file:///a.ts" },
        position: { line: 0, character: 23 },
      });

      expect(capturedCtx).toBeDefined();
      expect(capturedCtx!.wordAtCursor).toBe("Buck");
      expect(capturedCtx!.linePrefix).toBe("const bucket = new Buck");
    });

    test("handles document not in openDocuments gracefully", async () => {
      const plugin = createMockPlugin({
        completionProvider: () => [{ label: "Item" }],
      });
      server = new LspServer([plugin], { captureNotifications: true });
      // Don't open any document — should use empty string

      const res = await server.sendRequest("textDocument/completion", {
        textDocument: { uri: "file:///unknown.ts" },
        position: { line: 0, character: 0 },
      });

      expect(res.error).toBeUndefined();
      const result = res.result as { items: CompletionItem[] };
      expect(result.items).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Hover
  // -----------------------------------------------------------------------

  describe("textDocument/hover", () => {
    test("returns hover info from plugin", async () => {
      const plugin = createMockPlugin({
        hoverProvider: (ctx) => {
          if (ctx.word === "Bucket") return { contents: "**Bucket** — S3 bucket" };
          return undefined;
        },
      });
      server = new LspServer([plugin], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "new Bucket()");

      const res = await server.sendRequest("textDocument/hover", {
        textDocument: { uri: "file:///a.ts" },
        position: { line: 0, character: 6 },
      });

      const result = res.result as { contents: { kind: string; value: string } };
      expect(result).not.toBeNull();
      expect(result.contents.kind).toBe("markdown");
      expect(result.contents.value).toContain("Bucket");
    });

    test("first plugin to return info wins", async () => {
      const plugin1 = createMockPlugin({
        name: "first",
        hoverProvider: () => ({ contents: "from first" }),
      });
      const plugin2 = createMockPlugin({
        name: "second",
        hoverProvider: () => ({ contents: "from second" }),
      });
      server = new LspServer([plugin1, plugin2], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "word");

      const res = await server.sendRequest("textDocument/hover", {
        textDocument: { uri: "file:///a.ts" },
        position: { line: 0, character: 2 },
      });

      const result = res.result as { contents: { value: string } };
      expect(result.contents.value).toBe("from first");
    });

    test("returns null when no plugin returns info", async () => {
      const plugin = createMockPlugin({
        hoverProvider: () => undefined,
      });
      server = new LspServer([plugin], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "unknown");

      const res = await server.sendRequest("textDocument/hover", {
        textDocument: { uri: "file:///a.ts" },
        position: { line: 0, character: 3 },
      });

      expect(res.result).toBeNull();
    });

    test("returns null when no plugins have hoverProvider", async () => {
      server = new LspServer([createMockPlugin()], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "word");

      const res = await server.sendRequest("textDocument/hover", {
        textDocument: { uri: "file:///a.ts" },
        position: { line: 0, character: 2 },
      });

      expect(res.result).toBeNull();
    });

    test("extracts word at position across word boundaries", async () => {
      let capturedWord = "";
      const plugin = createMockPlugin({
        hoverProvider: (ctx) => {
          capturedWord = ctx.word;
          return undefined;
        },
      });
      server = new LspServer([plugin], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "const myVar = 42;");

      await server.sendRequest("textDocument/hover", {
        textDocument: { uri: "file:///a.ts" },
        position: { line: 0, character: 8 }, // middle of "myVar"
      });

      expect(capturedWord).toBe("myVar");
    });
  });

  // -----------------------------------------------------------------------
  // Code actions
  // -----------------------------------------------------------------------

  describe("textDocument/codeAction", () => {
    test("returns actions from plugin", async () => {
      const actions: CodeAction[] = [
        { title: "Fix import", kind: "quickfix", isPreferred: true },
      ];
      const plugin = createMockPlugin({
        codeActionProvider: () => actions,
      });
      server = new LspServer([plugin], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "code");

      const res = await server.sendRequest("textDocument/codeAction", {
        textDocument: { uri: "file:///a.ts" },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        context: { diagnostics: [] },
      });

      const result = res.result as CodeAction[];
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Fix import");
      expect(result[0].kind).toBe("quickfix");
    });

    test("aggregates actions from multiple plugins", async () => {
      const plugin1 = createMockPlugin({
        codeActionProvider: () => [{ title: "Action A", kind: "quickfix" as const }],
      });
      const plugin2 = createMockPlugin({
        codeActionProvider: () => [{ title: "Action B", kind: "refactor" as const }],
      });
      server = new LspServer([plugin1, plugin2], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "code");

      const res = await server.sendRequest("textDocument/codeAction", {
        textDocument: { uri: "file:///a.ts" },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        context: { diagnostics: [] },
      });

      const result = res.result as CodeAction[];
      expect(result).toHaveLength(2);
    });

    test("returns empty array when no plugins have codeActionProvider", async () => {
      server = new LspServer([createMockPlugin()], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "code");

      const res = await server.sendRequest("textDocument/codeAction", {
        textDocument: { uri: "file:///a.ts" },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        context: { diagnostics: [] },
      });

      const result = res.result as CodeAction[];
      expect(result).toHaveLength(0);
    });

    test("passes diagnostic context to plugin", async () => {
      let receivedCtx: CodeActionContext | undefined;
      const plugin = createMockPlugin({
        codeActionProvider: (ctx) => {
          receivedCtx = ctx;
          return [];
        },
      });
      server = new LspServer([plugin], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "code");

      await server.sendRequest("textDocument/codeAction", {
        textDocument: { uri: "file:///a.ts" },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        context: {
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
              message: "test issue",
              code: "R001",
              severity: 1,
            },
          ],
        },
      });

      expect(receivedCtx).toBeDefined();
      expect(receivedCtx!.diagnostics).toHaveLength(1);
      expect(receivedCtx!.diagnostics[0].ruleId).toBe("R001");
      expect(receivedCtx!.diagnostics[0].severity).toBe("error");
    });
  });

  // -----------------------------------------------------------------------
  // Diagnostics (pull model)
  // -----------------------------------------------------------------------

  describe("textDocument/diagnostic", () => {
    test("returns full diagnostic result", async () => {
      server = new LspServer([], { captureNotifications: true });
      server.openDocuments.set("file:///a.ts", "const x = 1;");

      const res = await server.sendRequest("textDocument/diagnostic", {
        textDocument: { uri: "file:///a.ts" },
      });

      const result = res.result as { kind: string; items: unknown[] };
      expect(result.kind).toBe("full");
      expect(Array.isArray(result.items)).toBe(true);
    });

    test("returns empty diagnostics for non-ts files", async () => {
      server = new LspServer([], { captureNotifications: true });
      server.openDocuments.set("file:///a.json", "{}");

      const res = await server.sendRequest("textDocument/diagnostic", {
        textDocument: { uri: "file:///a.json" },
      });

      const result = res.result as { items: unknown[] };
      expect(result.items).toHaveLength(0);
    });
  });
});
