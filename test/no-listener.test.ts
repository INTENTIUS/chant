/**
 * chant #2657 — chant never listens on a port and never renders (ws-052).
 *
 * The boundary with hud (docs/data/boundary.yaml) puts rendering, identity,
 * live sessions and the agent chat in hud, and keeps chant to the repository
 * specification, read through its CLI. This file holds `packages/core` to the
 * part of that a source scan can check:
 *
 * 1. No module opens an HTTP, TCP, UDP or WebSocket listener: no
 *    `createServer` or `createSecureServer`, no `.listen(`, no `new Server`
 *    from a network builtin or `ws`, no `Bun.serve` or `Deno.serve`, and no
 *    import of `Server` or `createServer` from `node:http`, `node:https`,
 *    `node:http2`, `node:net` or `node:tls`, and no import of `node:dgram`.
 *    `chant serve mcp` and `chant serve lsp` speak over stdio and stay
 *    allowed.
 * 2. No module imports, and `package.json` does not depend on, a package in
 *    {@link FORBIDDEN_PACKAGES}: UI frameworks, HTTP and WebSocket server
 *    frameworks, and agent runtimes and model SDKs. Each entry says why.
 *
 * ## The mechanism, and how it differs from no-egress
 *
 * `test/no-egress.test.ts` patches the socket prototype at run time, because
 * egress can arrive through a dependency and a grep can't see it. A listener
 * is different: it is opened by a call chant's own code makes, and there are
 * only a few spellings of it. So this is a static scan, and it parses each
 * file with the TypeScript compiler instead of matching text. Comments and
 * strings are not code, so a code generator that writes `app.listen(` into a
 * template, or the word `listener` in a comment, is not a finding. The
 * forbidden-package half then covers what arrives through a dependency: a
 * package that is not imported can't listen on chant's behalf.
 *
 * Test files, `__fixtures__` and `dist/` are left out: a test may start a
 * server to stand in for a registry, and the published code is `src/`.
 *
 * ## This is a regression gate, not a sandbox
 *
 * As with no-egress, the code under test is chant's own, and what is caught
 * is a maintainer adding a server by accident. Project code a build runs is
 * the sandbox's concern (architecture/sandbox.mdx).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const CORE = join(repoRoot, "packages", "core");

/**
 * Packages `packages/core` must never import or depend on, by name or by
 * scope prefix (an entry ending in `/`), with the reason.
 */
const FORBIDDEN_PACKAGES: readonly { name: string; why: string }[] = [
  // UI: chant never renders; rendering is hud's.
  { name: "react", why: "a UI framework; rendering belongs to hud" },
  { name: "react-dom", why: "renders React to a DOM or an HTML stream" },
  { name: "preact", why: "a UI framework" },
  { name: "vue", why: "a UI framework" },
  { name: "svelte", why: "a UI framework" },
  { name: "@sveltejs/", why: "Svelte's application framework and its server" },
  { name: "solid-js", why: "a UI framework" },
  { name: "@angular/", why: "a UI framework" },
  { name: "lit", why: "a web-component UI library" },
  { name: "next", why: "a UI framework with its own HTTP server" },
  { name: "nuxt", why: "a UI framework with its own HTTP server" },
  { name: "@remix-run/", why: "a UI framework with its own HTTP server" },
  { name: "ink", why: "renders a React UI in the terminal; chant prints text and JSON" },
  { name: "@xyflow/", why: "a graph-drawing UI; drawing the graph is hud's" },
  { name: "reactflow", why: "a graph-drawing UI; drawing the graph is hud's" },
  // Servers: chant never listens on a port.
  { name: "express", why: "an HTTP server framework" },
  { name: "fastify", why: "an HTTP server framework" },
  { name: "@fastify/", why: "HTTP server plugins" },
  { name: "koa", why: "an HTTP server framework" },
  { name: "hono", why: "an HTTP server framework" },
  { name: "@hono/", why: "Hono's Node server adapter and plugins" },
  { name: "connect", why: "an HTTP server middleware framework" },
  { name: "polka", why: "an HTTP server framework" },
  { name: "restify", why: "an HTTP server framework" },
  { name: "http-server", why: "a static HTTP server" },
  { name: "ws", why: "a WebSocket server and client; live sessions are hud's" },
  { name: "socket.io", why: "a WebSocket server; live sessions are hud's" },
  // Agent runtimes and model SDKs: the agent chat and its prompts are hud's and a plugin's.
  { name: "@anthropic-ai/", why: "a model SDK or agent runtime; chant hands agents data, never prompts" },
  { name: "openai", why: "a model SDK" },
  { name: "@openai/", why: "an agent runtime" },
  { name: "ai", why: "the Vercel AI SDK, an agent runtime" },
  { name: "@ai-sdk/", why: "Vercel AI SDK providers" },
  { name: "langchain", why: "an agent runtime" },
  { name: "@langchain/", why: "an agent runtime" },
  { name: "llamaindex", why: "an agent runtime" },
  { name: "@mastra/", why: "an agent runtime" },
  { name: "@modelcontextprotocol/", why: "the MCP SDK ships HTTP server transports; chant's MCP server speaks stdio with its own code" },
];

/** The package a bare specifier names: `@scope/name` or `name`, without a subpath. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The forbidden entry a package matches, if any. */
function forbiddenEntry(pkg: string) {
  return FORBIDDEN_PACKAGES.find((f) => (f.name.endsWith("/") ? pkg.startsWith(f.name) : pkg === f.name));
}

const NETWORK_BUILTINS = new Set(["http", "https", "http2", "net", "tls"]);
const LISTENER_NAMES = new Set(["createServer", "createSecureServer"]);

interface Finding {
  file: string;
  line: number;
  what: string;
}

/** Every listener and forbidden import in one file's source. */
function scanSource(file: string, text: string): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".mjs") || file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const out: Finding[] = [];
  const at = (node: ts.Node, what: string) => out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, what });
  const builtin = (spec: string) => spec.replace(/^node:/, "");

  const checkSpecifier = (node: ts.Node, spec: string) => {
    const pkg = packageOf(spec);
    const entry = pkg ? forbiddenEntry(pkg) : undefined;
    if (entry) at(node, `imports ${spec} (${entry.why})`);
    if (builtin(spec) === "dgram") at(node, `imports ${spec}, a UDP socket that binds a port`);
  };

  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      checkSpecifier(node, spec);
      if (NETWORK_BUILTINS.has(builtin(spec)) && ts.isImportDeclaration(node)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (imported === "Server" || LISTENER_NAMES.has(imported)) at(el, `imports ${imported} from ${spec}`);
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if ((callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) && arg && ts.isStringLiteralLike(arg)) {
        checkSpecifier(node, arg.text);
      }
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name && LISTENER_NAMES.has(name)) at(node, `calls ${callee.getText(sf)}(), which opens a server`);
      if (ts.isPropertyAccessExpression(callee) && name === "listen") at(node, `calls ${callee.getText(sf)}(), which listens on a port`);
      if (ts.isPropertyAccessExpression(callee) && name === "serve" && /^(Bun|Deno)$/.test(callee.expression.getText(sf))) at(node, `calls ${callee.getText(sf)}(), which listens on a port`);
    }
    if (ts.isNewExpression(node)) {
      const text = node.expression.getText(sf);
      if (/^(WebSocketServer|(\w+\.)?WebSocketServer|(https?|http2|net|tls)\.Server)$/.test(text)) at(node, `constructs ${text}, a server`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The source files a scan covers: `src/` and `bin/`, without tests, fixtures or build output. */
function coreSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "__fixtures__") continue;
      out.push(...coreSources(p));
    } else if (/\.(ts|mts|cts|mjs|js|cjs)$/.test(name) && !/\.test\.[mc]?[tj]s$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    } else if (!name.includes(".") && dir.endsWith("bin")) {
      out.push(p);
    }
  }
  return out;
}

describe("packages/core opens no listener and imports no UI or agent runtime (#2657)", () => {
  test("the scan finds each listener spelling and forbidden import in a sample", () => {
    const sample = [
      'import { createServer } from "node:http";',
      'import * as net from "node:net";',
      'import express from "express";',
      'import { query } from "@anthropic-ai/claude-agent-sdk";',
      'import dgram from "node:dgram";',
      "const s = net.createServer();",
      "s.listen(8080);",
      'const wss = new WebSocketServer({ port: 1 });',
      "Bun.serve({ fetch() {} });",
      'const r = await import("react");',
      'const w = require("ws");',
    ].join("\n");
    const whats = scanSource("sample.ts", sample).map((f) => `${f.line}: ${f.what}`);
    expect(whats).toEqual([
      "1: imports createServer from node:http",
      "3: imports express (an HTTP server framework)",
      "4: imports @anthropic-ai/claude-agent-sdk (a model SDK or agent runtime; chant hands agents data, never prompts)",
      "5: imports node:dgram, a UDP socket that binds a port",
      "6: calls net.createServer(), which opens a server",
      "7: calls s.listen(), which listens on a port",
      "8: constructs WebSocketServer, a server",
      "9: calls Bun.serve(), which listens on a port",
      "10: imports react (a UI framework; rendering belongs to hud)",
      "11: imports ws (a WebSocket server and client; live sessions are hud's)",
    ]);
  });

  test("text in comments and strings is not a finding, and outbound sockets are no-egress's concern", () => {
    const sample = [
      "// app.listen(3000) and createServer() in a comment",
      'const template = `import express from "express";\\napp.listen(3000);`;',
      'import { createConnection } from "node:net";',
      'import { resolve } from "node:path";',
      "const listener = () => {};",
    ].join("\n");
    expect(scanSource("sample.ts", sample)).toEqual([]);
  });

  test("no source file in packages/core opens a listener or imports a forbidden package", () => {
    const files = [...coreSources(join(CORE, "src")), ...coreSources(join(CORE, "bin"))];
    expect(files.length).toBeGreaterThan(100);
    const findings = files.flatMap((f) => scanSource(relative(repoRoot, f), readFileSync(f, "utf-8")));
    expect(findings.map((f) => `${f.file}:${f.line}: ${f.what}`)).toEqual([]);
  });

  test("packages/core/package.json depends on no forbidden package", () => {
    const pkg = JSON.parse(readFileSync(join(CORE, "package.json"), "utf-8")) as Record<string, Record<string, string> | undefined>;
    const deps = ["dependencies", "optionalDependencies", "peerDependencies"].flatMap((k) => Object.keys(pkg[k] ?? {}));
    expect(deps.length).toBeGreaterThan(0);
    expect(deps.filter((d) => forbiddenEntry(d)).map((d) => `${d} (${forbiddenEntry(d)!.why})`)).toEqual([]);
  });
});
