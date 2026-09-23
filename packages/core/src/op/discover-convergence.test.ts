import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOps } from "./discover";
import { resetDiscoveryWarnings } from "../discovery/convergence";

/**
 * chant#2527's warning release for Op discovery. The upward search for the
 * Op root stays as it is; what changes next release is the downward walk,
 * which stops at child projects. Today an Op in a child project is
 * discovered, and it still is here, with a warning naming it.
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

const OP_FILE = (name: string): string =>
  `export default { props: { name: ${JSON.stringify(name)}, overview: "t", phases: [{ name: "Run", steps: [] }] } };\n`;

describe("discoverOps — an Op in a child project (#2527 warning release)", () => {
  let root: string;
  let stderr: string[];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "chant-2527-ops-")));
    fakeGitRoot = root;
    resetDiscoveryWarnings();
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void stderr.push(args.join(" ")));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(join(root, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
    mkdirSync(join(root, "ops"), { recursive: true });
    writeFileSync(join(root, "ops", "mine.op.ts"), OP_FILE("mine"));
    mkdirSync(join(root, "child", "ops"), { recursive: true });
    writeFileSync(join(root, "child", "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
    writeFileSync(join(root, "child", "ops", "theirs.op.ts"), OP_FILE("theirs"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  test("is still discovered, and the warning names it with the include glob", async () => {
    const { ops, errors } = await discoverOps({ cwd: root });
    expect(errors).toEqual([]);
    expect([...ops.keys()].sort()).toEqual(["mine", "theirs"]);
    expect(stderr).toEqual([
      "warning: Op discovery under the current directory changes in the next release (chant#2527):\n" +
        "  child/ops/theirs.op.ts: child/ is a child project with its own chant.config. " +
        "Discovery stops at child projects from the next release. " +
        'To keep reading it after the change, add "child" to include in chant.config.json, which the next release honours.',
    ]);
  });

  test("with the glob in the config, nothing is printed", async () => {
    writeFileSync(join(root, "chant.config.json"), JSON.stringify({ lexicons: ["aws"], include: ["child"] }));
    const { ops } = await discoverOps({ cwd: root });
    expect([...ops.keys()].sort()).toEqual(["mine", "theirs"]);
    expect(stderr).toEqual([]);
  });
});
