import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOps } from "./discover";

/**
 * #2058 — Op discovery scoped to the project root, the way entity discovery
 * is. The repro: a chant project nested in a larger checkout (behold's
 * committed `example-carve/app` beside `example-writes`, `example-k8s`)
 * discovered every sibling project's `*.op.ts` as its own, because the scan
 * root was the git root unconditionally.
 *
 * The fake git root is a temp tree; the runtime mock answers `git rev-parse`
 * with whatever the current test set (`realpath`ed, since macOS's tmpdir is a
 * symlink and the walk compares resolved paths).
 */
let fakeGitRoot = "";
vi.mock("../runtime-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-adapter")>()),
  getRuntime: () => ({
    spawn: async (cmd: string[]) =>
      cmd[0] === "git" && cmd[1] === "rev-parse"
        ? { stdout: fakeGitRoot, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 },
  }),
}));

/** A minimal default export shaped the way discovery validates (entity.props = OpConfig). */
const OP_FILE = (name: string): string =>
  `export default { props: { name: ${JSON.stringify(name)}, overview: "t", phases: [{ name: "Run", steps: [] }] } };\n`;

describe("discoverOps — the scan root is the project, not the checkout (#2058)", () => {
  let checkout: string;
  beforeEach(() => {
    checkout = realpathSync(mkdtempSync(join(tmpdir(), "chant-op-root-")));
    fakeGitRoot = checkout;
    // The monorepo shape from the issue: two sibling chant projects, each
    // with its own config and ops, nested in one git checkout.
    mkdirSync(join(checkout, "app", "ops"), { recursive: true });
    writeFileSync(join(checkout, "app", "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
    writeFileSync(join(checkout, "app", "ops", "mine.op.ts"), OP_FILE("mine"));
    mkdirSync(join(checkout, "sibling", "ops"), { recursive: true });
    writeFileSync(join(checkout, "sibling", "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
    writeFileSync(join(checkout, "sibling", "ops", "theirs.op.ts"), OP_FILE("theirs"));
    // A configless dir at the checkout root, with an op of its own.
    mkdirSync(join(checkout, "ops"), { recursive: true });
    writeFileSync(join(checkout, "ops", "root.op.ts"), OP_FILE("root"));
  });
  afterEach(() => rmSync(checkout, { recursive: true, force: true }));

  test("from inside a project, only that project's Ops are discovered — never a sibling's", async () => {
    const { ops, errors } = await discoverOps({ cwd: join(checkout, "app") });
    expect(errors).toEqual([]);
    expect([...ops.keys()]).toEqual(["mine"]);
  });

  test("the walk finds the config from a subdirectory of the project too (ops/ beside src/, #1675)", async () => {
    const { ops } = await discoverOps({ cwd: join(checkout, "app", "ops") });
    expect([...ops.keys()]).toEqual(["mine"]);
  });

  test("with no chant config anywhere up to the git root, the git root stands — #1675's original scope", async () => {
    rmSync(join(checkout, "app", "chant.config.json"));
    rmSync(join(checkout, "sibling", "chant.config.json"));
    const { ops } = await discoverOps({ cwd: join(checkout, "app") });
    expect([...ops.keys()].sort()).toEqual(["mine", "root", "theirs"]);
  });
});

/**
 * #2171. An Op may be exported by name, not only as the file's default.
 *
 * Discovery used to read `mod.default` alone, which forced every runnable Op
 * into the one export shape the fold path refuses, so an Op under a project's
 * `sourceDir` cost that project its fold coverage. The default export is still
 * accepted, unchanged; these cases are the widening around it.
 *
 * Same fake-git-root harness as the suite above: the Op files here are written
 * as plain object literals with a `props` field, which is the shape discovery
 * actually validates, so the fixtures stay free of the Op builders.
 */
describe("discoverOps: an Op may be exported by name (#2171)", () => {
  const OP_VALUE = (name: string): string =>
    `{ props: { name: ${JSON.stringify(name)}, overview: "t", phases: [{ name: "Run", steps: [] }] } }`;

  let checkout: string;
  const write = (file: string, body: string): void => {
    writeFileSync(join(checkout, "ops", file), body);
  };

  beforeEach(() => {
    checkout = realpathSync(mkdtempSync(join(tmpdir(), "chant-op-named-")));
    fakeGitRoot = checkout;
    mkdirSync(join(checkout, "ops"), { recursive: true });
    writeFileSync(join(checkout, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
  });
  afterEach(() => rmSync(checkout, { recursive: true, force: true }));

  test("a named export is discovered", async () => {
    write("named.op.ts", `export const deploy = ${OP_VALUE("deploy")};\n`);
    const { ops, errors } = await discoverOps({ cwd: checkout });
    expect(errors).toEqual([]);
    expect([...ops.keys()]).toEqual(["deploy"]);
    expect(ops.get("deploy")!.exportName).toBe("deploy");
  });

  test("the default export still works, and reports itself as the default", async () => {
    write("legacy.op.ts", `export default ${OP_VALUE("legacy")};\n`);
    const { ops, errors } = await discoverOps({ cwd: checkout });
    expect(errors).toEqual([]);
    expect([...ops.keys()]).toEqual(["legacy"]);
    expect(ops.get("legacy")!.exportName).toBe("default");
  });

  test("one file may declare several Ops, and each is registered on its own", async () => {
    write("many.op.ts", `export const a = ${OP_VALUE("alpha")};\nexport const b = ${OP_VALUE("beta")};\n`);
    const { ops, errors } = await discoverOps({ cwd: checkout });
    expect(errors).toEqual([]);
    expect([...ops.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(ops.get("alpha")!.filePath).toBe(ops.get("beta")!.filePath);
  });

  test("a default and a named Op in one file are both registered", async () => {
    write("both.op.ts", `export default ${OP_VALUE("first")};\nexport const other = ${OP_VALUE("second")};\n`);
    const { ops, errors } = await discoverOps({ cwd: checkout });
    expect(errors).toEqual([]);
    expect([...ops.keys()].sort()).toEqual(["first", "second"]);
  });

  test("the same Op exported twice is one Op, not a self-collision", async () => {
    write("aliased.op.ts", `const op = ${OP_VALUE("aliased")};\nexport default op;\nexport { op };\n`);
    const { ops, errors } = await discoverOps({ cwd: checkout });
    expect(errors).toEqual([]);
    expect([...ops.keys()]).toEqual(["aliased"]);
    expect(ops.get("aliased")!.exportName).toBe("default");
  });

  test("exports that are not Ops are skipped in silence", async () => {
    write("mixed.op.ts", `export const meta = { team: "infra" };\nexport const notQuite = { props: { name: "x" } };\nexport const real = ${OP_VALUE("real")};\n`);
    const { ops, errors } = await discoverOps({ cwd: checkout });
    expect(errors).toEqual([]);
    expect([...ops.keys()]).toEqual(["real"]);
  });

  test("a file exporting no Op at all is the error, and names both accepted shapes", async () => {
    write("empty.op.ts", `export const meta = { team: "infra" };\n`);
    const { ops, errors } = await discoverOps({ cwd: checkout });
    expect(ops.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("exports no Op");
    expect(errors[0]).toContain("export default Op({...})");
    expect(errors[0]).toContain("export const deploy = Op({...})");
  });

  test("two files declaring the same Op name still collide", async () => {
    write("one.op.ts", `export const a = ${OP_VALUE("same")};\n`);
    write("two.op.ts", `export const b = ${OP_VALUE("same")};\n`);
    const { ops, errors } = await discoverOps({ cwd: checkout });
    expect(ops.size).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Duplicate Op name "same" in .+ and .+$/);
  });

  test("two Ops sharing a name inside one file collide, and the message says so", async () => {
    write("clash.op.ts", `export const a = ${OP_VALUE("twice")};\nexport const b = ${OP_VALUE("twice")};\n`);
    const { ops, errors } = await discoverOps({ cwd: checkout });
    expect(ops.size).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`Duplicate Op name "twice" declared twice in`);
  });
});
