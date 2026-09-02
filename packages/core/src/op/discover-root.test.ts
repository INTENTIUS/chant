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
vi.mock("../runtime-adapter", () => ({
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
