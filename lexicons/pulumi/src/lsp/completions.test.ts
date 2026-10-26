import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CompletionContext } from "@intentius/chant/lsp/types";
import { completions } from "./completions";

/** A context whose cursor sits at the end of `content`. */
function at(uri: string, content: string): CompletionContext {
  const lines = content.split("\n");
  const line = lines.length - 1;
  const linePrefix = lines[line];
  return {
    uri,
    content,
    position: { line, character: linePrefix.length },
    linePrefix,
    wordAtCursor: /(\w+)$/.exec(linePrefix)?.[1] ?? "",
  };
}

const labels = (items: { label: string }[]) => items.map((i) => i.label);

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("pulumi completions", () => {
  test("ignore every document that is not a pulumi surface", () => {
    expect(completions(at("file:///p/src/infra.ts", "export const x = {"))).toEqual([]);
    expect(completions(at("file:///p/values.yaml", "na"))).toEqual([]);
  });

  test("Pulumi.yaml: top-level keys by prefix", () => {
    expect(labels(completions(at("file:///p/Pulumi.yaml", "name: app\nru")))).toEqual(["runtime"]);
    expect(labels(completions(at("file:///p/Pulumi.yaml", "")))).toContain("backend");
  });

  test("Pulumi.yaml: runtime values and nested keys", () => {
    expect(labels(completions(at("file:///p/Pulumi.yaml", "name: app\nruntime: no")))).toEqual(["nodejs"]);
    expect(labels(completions(at("file:///p/Pulumi.yaml", "name: app\nruntime:\n  name: ya")))).toEqual(["yaml"]);
    expect(labels(completions(at("file:///p/Pulumi.yaml", "name: app\nbackend:\n  u")))).toEqual(["url"]);
    expect(labels(completions(at("file:///p/Pulumi.yaml", "runtime:\n  name: nodejs\n  options:\n    package")))).toEqual(["packagemanager"]);
  });

  test("Pulumi.<stack>.yaml: stack keys, and the project's namespace under config", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulumi-lsp-"));
    dirs.push(dir);
    writeFileSync(join(dir, "Pulumi.yaml"), "name: shop\nruntime: yaml\n");
    expect(labels(completions(at(`file://${dir}/Pulumi.dev.yaml`, "secrets")))).toEqual(["secretsprovider"]);
    expect(labels(completions(at(`file://${dir}/Pulumi.dev.yaml`, "config:\n  sh")))).toEqual(["shop:"]);
    expect(labels(completions(at(`file://${dir}/Pulumi.dev.yaml`, "config:\n  zz")))).toEqual([]);
  });

  test("chant.workspace.json: pulumi as a member kind, and nowhere else", () => {
    const decl = `{\n  "name": "w",\n  "members": [\n    { "name": "infra", "dir": "infra", "kind": "pu`;
    expect(labels(completions(at("file:///w/chant.workspace.json", decl)))).toEqual(["pulumi"]);
    expect(completions(at("file:///w/chant.workspace.json", `{\n  "records": [{ "kind": "pu`))).toEqual([]);
  });

  test("chant.config.ts: the pulumi namespace, member keys and engine values", () => {
    expect(labels(completions(at("file:///p/chant.config.ts", "export default {\n  pulumi: {\n    me")))).toEqual(["member"]);
    expect(labels(completions(at("file:///p/chant.config.ts", "export default {\n  pulumi: { member: {\n    ")))).toEqual(["dir", "label", "engine", "stack"]);
    expect(labels(completions(at("file:///p/chant.config.ts", 'export default { pulumi: { member: { dir: "./infra", engine: "pl')))).toEqual(["plunge"]);
    expect(completions(at("file:///p/chant.config.ts", "export default {\n  terraform: {\n    ro"))).toEqual([]);
  });
});
