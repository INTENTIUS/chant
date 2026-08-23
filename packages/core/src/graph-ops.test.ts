import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discover } from "./discovery/index";
import { buildGraphIr } from "./graph-ir";
import { mergeProjectOps } from "./graph-ops";

const exec = promisify(execFile);

// #1675 — a project laid out the conventional way: `sourceDir: "src"` holds the
// infra, and the op sits at the project root beside it. Discovery (scoped to
// src/) never sees the op; discoverOps (scoped to the git root) does. The IR
// must carry it.
describe("mergeProjectOps (#1675)", () => {
  let root: string;
  const opModule = join(process.cwd(), "packages/core/src/op/index.ts");

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "chant-graph-ops-")));
    await exec("git", ["init", "-q", root]);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "chant.config.ts"), `export default { sourceDir: "src" };\n`);
    await writeFile(
      join(root, "src", "infra.ts"),
      `import { Op, phase, activity } from "${opModule}";\n` +
        `export const inner = Op({ name: "inner", phases: [phase("P", [activity("build")])] });\n`,
    );
    await writeFile(
      join(root, "deploy.op.ts"),
      `import { Op, phase, activity, gate } from "${opModule}";\n` +
        `export default Op({ name: "deploy", overview: "ship it", depends: ["inner"], phases: [phase("Apply", [activity("build"), gate("approve")])] });\n`,
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("an op at the project root joins the entities discovery loaded from sourceDir", async () => {
    const result = await discover(join(root, "src"));
    expect(result.errors).toEqual([]);
    expect([...result.entities.keys()]).toEqual(["inner"]);

    const merged = await mergeProjectOps(result.entities, result.sourceFiles, root);
    expect(merged.errors).toEqual([]);
    expect(merged.added).toEqual(["deploy"]);

    const ir = buildGraphIr(result.entities, root);
    const node = ir.nodes.find((n) => n.id === "deploy");
    expect(node).toMatchObject({ kind: "Temporal::Op", lexicon: "temporal", sourceLoc: { file: "deploy.op.ts" } });
    expect(node?.attrs.name).toBe("deploy");
    expect(node?.attrs.depends).toEqual(["inner"]);
    expect(node?.attrs.phases).toEqual([
      { name: "Apply", steps: [{ kind: "activity", fn: "build" }, { kind: "gate", signalName: "approve" }] },
    ]);
    // The sourceDir op discovery already loaded is untouched, not duplicated.
    expect(ir.nodes.filter((n) => n.kind === "Temporal::Op")).toHaveLength(2);
  });

  test("is idempotent — a second merge adds nothing", async () => {
    const result = await discover(join(root, "src"));
    await mergeProjectOps(result.entities, result.sourceFiles, root);
    const again = await mergeProjectOps(result.entities, result.sourceFiles, root);
    expect(again.added).toEqual([]);
  });
});
