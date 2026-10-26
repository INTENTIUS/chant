import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { HoverContext } from "@intentius/chant/lsp/types";
import { hover } from "./hover";

/** A context hovering `word` on line `line` of `content`. */
function on(uri: string, content: string, line: number, word: string): HoverContext {
  const lineText = content.split("\n")[line];
  return { uri, content, position: { line, character: lineText.indexOf(word) + 1 }, word, lineText };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("pulumi hover", () => {
  test("returns nothing for a document that is not a pulumi surface", () => {
    expect(hover(on("file:///p/src/infra.ts", "const name = 1", 0, "name"))).toBeUndefined();
  });

  test("Pulumi.yaml: a key says what chant does with it", () => {
    const content = "name: app\nruntime: nodejs\nbackend:\n  url: plunge+file://./state\n";
    expect(hover(on("file:///p/Pulumi.yaml", content, 0, "name"))?.contents).toContain("URN");
    expect(hover(on("file:///p/Pulumi.yaml", content, 3, "url"))?.contents).toContain("plunge");
    expect(hover(on("file:///p/Pulumi.yaml", content, 1, "nodejs"))?.contents).toContain("Node.js");
  });

  test("Pulumi.<stack>.yaml: config keys by namespace, and secure", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulumi-lsp-"));
    dirs.push(dir);
    writeFileSync(join(dir, "Pulumi.yaml"), "name: shop\nruntime: yaml\n");
    const content = "config:\n  shop:bucketName: assets\n  aws:region: us-east-1\n  shop:token:\n    secure: AAAB\n";
    const uri = `file://${dir}/Pulumi.dev.yaml`;
    expect(hover(on(uri, content, 1, "bucketName"))?.contents).toContain("This project's config key");
    expect(hover(on(uri, content, 2, "aws"))?.contents).toContain("`aws` package or provider");
    expect(hover(on(uri, content, 4, "secure"))?.contents).toContain("never decrypts");
    expect(hover(on(uri, content, 0, "config"))?.contents).toContain("selected stack");
  });

  test("chant.workspace.json: the member kind", () => {
    const content = `{ "members": [\n  { "name": "infra", "dir": "infra", "kind": "pulumi" }\n] }`;
    expect(hover(on("file:///w/chant.workspace.json", content, 1, "pulumi"))?.contents).toContain("pulumi preview --json");
    expect(hover(on("file:///w/chant.workspace.json", content, 1, "infra"))).toBeUndefined();
  });

  test("chant.config.ts: pulumi.member keys", () => {
    const content = 'export default {\n  pulumi: {\n    member: {\n      dir: "./infra",\n      engine: "plunge",\n    },\n  },\n};';
    expect(hover(on("file:///p/chant.config.ts", content, 3, "dir"))?.contents).toContain("project root");
    expect(hover(on("file:///p/chant.config.ts", content, 4, "engine"))?.contents).toContain("backend.url");
    expect(hover(on("file:///p/chant.config.ts", content, 2, "member"))?.contents).toContain("stack-export.json");
  });
});
