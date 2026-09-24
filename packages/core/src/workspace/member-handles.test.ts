import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readSourceHandles } from "./member-handles";
import { workingTree } from "./tree";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "chant-handles-"));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return workingTree(root);
}
const names = (hs: { name: string }[]) => hs.map((h) => h.name);

describe("readSourceHandles (#2539)", () => {
  test("reads output names, stackOutput bindings and Parameter bindings, without running anything", () => {
    const t = tree({
      "src/outputs.ts": [
        `import { output as out, stackOutput } from "@intentius/chant-lexicon-aws";`,
        `const NAME = "ListenerArn";`,
        `export const a = out(x.Arn, "ClusterArn");`,
        `export const b = out(x.Arn, NAME);`,
        `export const c = out(x.Arn, \`Plain\`);`,
        `export const zoneServers = stackOutput(zone.NameServers);`,
        `throw new Error("never run");`,
      ].join("\n"),
      "src/params.ts": [
        `import * as aws from "@intentius/chant-lexicon-aws";`,
        `export const clusterArn = new aws.Parameter("String");`,
        `const internal = new aws.Parameter("String");`,
      ].join("\n"),
    });
    const read = readSourceHandles(t, "");
    expect(names(read.outputs).sort()).toEqual(["ClusterArn", "ListenerArn", "Plain", "zoneServers"]);
    expect(names(read.inputs)).toEqual(["clusterArn"]);
    expect(read.gaps).toEqual([]);
    expect(read.outputs.find((o) => o.name === "ClusterArn")).toEqual({ name: "ClusterArn", file: "src/outputs.ts", line: 3 });
  });

  test("only chant's functions count", () => {
    const t = tree({
      "a.ts": `import { output } from "./local";\nexport const a = output(1, "NotChant");\n`,
      "b.ts": `import { stackOutput } from "@intentius/chant/components";\nexport const b = stackOutput("shared", "ClusterArn");\n`,
      "c.ts": `function output(a: unknown, b: string) { return b; }\nexport const c = output(1, "Local");\n`,
    });
    expect(readSourceHandles(t, "")).toEqual({ outputs: [], inputs: [], gaps: [] });
  });

  test("a name that isn't a literal is a gap", () => {
    const t = tree({ "o.ts": `import { output } from "@intentius/chant";\nexport const o = output(1, prefix + "Arn");\n` });
    expect(readSourceHandles(t, "").gaps).toEqual(["o.ts:2: an output whose name is not a string literal"]);
  });

  test("tests, declarations, build output, node_modules and excluded directories are not source", () => {
    const decl = `import { output } from "@intentius/chant";\nexport const o = output(1, "X");\n`;
    const t = tree({
      "src/o.test.ts": decl,
      "src/o.d.ts": decl,
      "dist/o.ts": decl,
      "node_modules/p/o.ts": decl,
      ".cache/o.ts": decl,
      "chant.config.ts": decl,
      "other/o.ts": decl,
      "src/kept.ts": decl,
    });
    expect(readSourceHandles(t, "", new Set(["other"])).outputs.map((o) => o.file)).toEqual(["src/kept.ts"]);
  });
});
