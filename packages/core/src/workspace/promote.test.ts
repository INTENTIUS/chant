import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { GateLedgerPort } from "../op/gate";
import { nextRung, promoteCommand, setMemberKind, type PromoteRunner } from "./promote";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf-8" });

function ledger(): GateLedgerPort & { approve(digest: string): void } {
  const pending: never[] = [];
  const resolutions: unknown[] = [];
  return {
    async read() {
      return { resolutions, pending } as never;
    },
    async appendPending(input: Record<string, unknown>) {
      (pending as unknown[]).push({ ...input, at: new Date().toISOString() });
      return { record: input, pushed: false } as never;
    },
    approve(digest: string) {
      resolutions.push({ gate: "net", planDigest: digest, resolvedBy: "alex", outcome: "approved", at: new Date().toISOString() });
    },
  } as never;
}

describe("the ladder (#3178)", () => {
  test("terraform to choudoufu, choudoufu or other to chant, chant has no rung", () => {
    expect(nextRung("terraform")).toEqual({ from: "terraform", to: "choudoufu" });
    expect(nextRung("choudoufu")?.to).toBe("chant");
    expect(nextRung("other")?.to).toBe("chant");
    expect(nextRung("chant")).toBeUndefined();
  });
  test("setMemberKind changes only the named member", () => {
    const text = JSON.stringify({ name: "w", schema: 1, members: [{ name: "a", dir: "a", kind: "terraform" }, { name: "b", dir: "b", kind: "terraform" }] }, null, 2);
    const out = JSON.parse(setMemberKind(text, "chant.workspace.json", "b", "choudoufu"));
    expect(out.members.map((m: { kind: string }) => m.kind)).toEqual(["terraform", "choudoufu"]);
  });
});

describe("chant workspace promote (#3178)", () => {
  let root: string;
  let calls: { argv: string[]; cwd: string }[];
  const runner: PromoteRunner = async (argv, cwd) => {
    calls.push({ argv, cwd });
    if (argv[0] === "chant") mkdirSync(join(cwd, "src"), { recursive: true });
    if (argv[0] === "chant") writeFileSync(join(cwd, "src", "index.ts"), "export {};\n");
    return { exitCode: 0, output: "" };
  };
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    calls = [];
    root = mkdtempSync(join(tmpdir(), "chant-promote-test-"));
    git(root, "init", "-q", "-b", "main");
    mkdirSync(join(root, "net"));
    writeFileSync(join(root, "net", "main.tf"), "# tf\n");
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "w", schema: 1, members: [{ name: "net", dir: "net", kind: "terraform" }] }, null, 2) + "\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const kind = () => JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf-8")).members[0].kind;

  test("terraform to choudoufu: runs live-check and the adoption report in a worktree, gates, then applies and stamps", async () => {
    const l = ledger();
    const first = await promoteCommand({ root, member: "net", state: "/s/terraform.tfstate", runner, ledger: l });
    expect(first.outcome).toBe("gated");
    expect(first.exitCode).toBe(3);
    expect(calls.map((c) => c.argv.slice(0, 2).join(" "))).toEqual(["choudoufu live-check", "choudoufu live-import"]);
    expect(calls.every((c) => !c.argv.includes("-approve") && c.cwd !== join(realpathSync(root), "net"))).toBe(true);
    expect(kind()).toBe("terraform");

    l.approve(first.digest!);
    calls = [];
    const second = await promoteCommand({ root, member: "net", state: "/s/terraform.tfstate", runner, ledger: l });
    expect(second.outcome).toBe("applied");
    expect(second.digest).toBe(first.digest);
    expect(kind()).toBe("choudoufu");
    expect(calls.at(-1)?.argv).toContain("-approve");
    expect(calls.at(-1)?.cwd).toBe(join(realpathSync(root), "net"));
  });

  test("a failing live-check stops before any gate and leaves the tree alone", async () => {
    const l = ledger();
    const failing: PromoteRunner = async (argv) => ({ exitCode: argv[1] === "live-check" ? 2 : 0, output: "unsupported construct" });
    const r = await promoteCommand({ root, member: "net", state: "s", runner: failing, ledger: l });
    expect(r.outcome).toBe("checks-failed");
    expect(kind()).toBe("terraform");
    expect(git(root, "status", "--porcelain")).toBe("");
    expect((await l.read("workspace-promote")).pending).toHaveLength(0);
  });

  test("choudoufu to chant runs chant import and the patch carries the generated files", async () => {
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "w", schema: 1, members: [{ name: "net", dir: "net", kind: "choudoufu" }] }, null, 2) + "\n");
    git(root, "commit", "-qam", "kind");
    const l = ledger();
    const first = await promoteCommand({ root, member: "net", runner, ledger: l, dryRun: true });
    expect(first.outcome).toBe("dry-run");
    expect(first.patch).toContain("net/src/index.ts");
    expect(calls[0].argv).toEqual(["chant", "import", ".", "--lexicon", "terraform", "--output", "src/"]);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  test("terraform needs --state, other needs --lexicon, chant is the top", async () => {
    await expect(promoteCommand({ root, member: "net", runner })).rejects.toThrow(/--state/);
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "w", schema: 1, members: [{ name: "net", dir: "net", kind: "other", because: "x" }] }, null, 2) + "\n");
    git(root, "commit", "-qam", "other");
    await expect(promoteCommand({ root, member: "net", runner })).rejects.toThrow(/--lexicon/);
  });
});
