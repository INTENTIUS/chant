import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { GateLedgerPort } from "../op/gate";
import { PENDING_STAMP_SCHEMA, nextRung, promoteCommand, readPendingStamp, setMemberKind, type PromoteRunner } from "./promote";

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
    expect(calls.map((c) => c.argv.slice(0, 2).join(" "))).toEqual(["choudoufu init", "choudoufu live-check", "choudoufu live-import"]);
    expect(calls.every((c) => !c.argv.includes("-approve") && c.cwd !== join(realpathSync(root), "net"))).toBe(true);
    expect(kind()).toBe("terraform");

    l.approve(first.digest!);
    calls = [];
    const second = await promoteCommand({ root, member: "net", state: "/s/terraform.tfstate", runner, ledger: l });
    expect(second.outcome).toBe("applied");
    expect(second.digest).toBe(first.digest);
    expect(kind()).toBe("choudoufu");
    expect(calls.at(-1)?.argv).toContain("-approve");
    // The stamp runs where the staging's choudoufu init installed the providers, not in the tree (chant#4492).
    expect(calls[0]!.argv.slice(0, 2)).toEqual(["choudoufu", "init"]);
    expect(calls.at(-1)?.cwd).toBe(calls[0]!.cwd);
    expect(calls.at(-1)?.cwd).not.toBe(join(realpathSync(root), "net"));
  });

  test("the staging installs providers with choudoufu init, and nothing it writes under .terraform/ reaches the patch (#4461)", async () => {
    const l = ledger();
    const installing: PromoteRunner = async (argv, cwd) => {
      calls.push({ argv, cwd });
      if (argv[1] === "init") {
        mkdirSync(join(cwd, ".terraform", "providers"), { recursive: true });
        writeFileSync(join(cwd, ".terraform", "providers", "aws"), "a provider binary\n");
      }
      return { exitCode: 0, output: "" };
    };
    const r = await promoteCommand({ root, member: "net", state: "/s/terraform.tfstate", runner: installing, ledger: l });
    expect(r.outcome).toBe("gated");
    expect(calls[0]!.argv).toEqual(["choudoufu", "init", "-input=false", "-backend=false", "-no-color"]);
    expect(r.patch).not.toContain(".terraform");
    expect(r.patch).toContain('"kind": "choudoufu"');
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

  test("the dry run carries live-import's report, one entry per resource with its status, and writes nothing (behold#999)", async () => {
    const report = [
      "",
      'Ratifying /s/terraform.tfstate for estate "net" against the live system. This was read-only: nothing was written.',
      "",
      "VERIFIED (1) - verified against the live system:",
      "  aws_s3_bucket.logs                         aws_s3_bucket            live id: net-logs",
      "    every attribute matched",
      "",
      "UNTAGGABLE (1) - outside the taggable subset:",
      "  aws_s3_bucket_versioning.logs              aws_s3_bucket_versioning live id: net-logs",
      "    no tags argument",
      "",
      "1 of 2 resource instance(s) are eligible for stamping (VERIFIED or DRIFTED).",
    ].join("\n");
    const reporting: PromoteRunner = async (argv, cwd) => {
      calls.push({ argv, cwd });
      return { exitCode: 0, output: argv[1] === "live-import" ? report : "" };
    };
    const l = ledger();
    const r = await promoteCommand({ root, member: "net", state: "/s/terraform.tfstate", runner: reporting, ledger: l, dryRun: true });
    expect(r.outcome).toBe("dry-run");
    expect(r.adoption?.entries.map((e) => [e.address, e.status, e.claimed])).toEqual([
      ["aws_s3_bucket.logs", "VERIFIED", true],
      ["aws_s3_bucket_versioning.logs", "UNTAGGABLE", false],
    ]);
    expect(calls.some((c) => c.argv.includes("-approve"))).toBe(false);
    expect((await l.read("workspace-promote")).pending).toHaveLength(0);
    expect(kind()).toBe("terraform");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  test("terraform needs --state, other needs --lexicon, chant is the top", async () => {
    await expect(promoteCommand({ root, member: "net", runner })).rejects.toThrow(/--state/);
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "w", schema: 1, members: [{ name: "net", dir: "net", kind: "other", because: "x" }] }, null, 2) + "\n");
    git(root, "commit", "-qam", "other");
    await expect(promoteCommand({ root, member: "net", runner })).rejects.toThrow(/--lexicon/);
  });
  describe("the single-member stamp retry (#4485, chant#4509)", () => {
    const record = () => join(root, ".chant", "workspace-promote", "net.stamp.json");
    /** A fake choudoufu whose `live-import -approve` fails while `failStamp` is set, and whose init fails while `failInit` is set. */
    let failStamp: boolean;
    let failInit: boolean;
    const choudoufu: PromoteRunner = async (argv, cwd) => {
      calls.push({ argv, cwd });
      if (argv[0] === "chant") return { exitCode: 0, output: "" };
      if (argv[1] === "init" && failInit) return { exitCode: 1, output: "Error: Failed to query available provider packages" };
      if (argv.includes("-approve")) return failStamp ? { exitCode: 1, output: "Error: the live system refused the stamp write" } : { exitCode: 0, output: "2 resource(s) newly stamped, 0 already stamped, 0 failed.\n" };
      return { exitCode: 0, output: "" };
    };
    /** Promote net to choudoufu with its stamp failing: the kind is written and the stamp is left pending. */
    const promoteWithFailedStamp = async (l: ReturnType<typeof ledger>) => {
      const first = await promoteCommand({ root, member: "net", state: "/s/terraform.tfstate", runner: choudoufu, ledger: l });
      expect(first.outcome).toBe("gated");
      l.approve(first.digest!);
      failStamp = true;
      const second = await promoteCommand({ root, member: "net", state: "/s/terraform.tfstate", runner: choudoufu, ledger: l });
      failStamp = false;
      return second;
    };
    beforeEach(() => {
      failStamp = false;
      failInit = false;
    });

    test("a failed stamp leaves a pending record; the same command retries only the stamp, in a staging of its own", async () => {
      const l = ledger();
      const failed = await promoteWithFailedStamp(l);
      expect(failed.outcome).toBe("applied");
      expect(failed.exitCode).toBe(1);
      expect(failed.followUpFailed).toBe("choudoufu live-import -approve");
      expect(kind()).toBe("choudoufu");
      expect(existsSync(record())).toBe(true);
      expect(readPendingStamp(realpathSync(root), "net")).toMatchObject({ schema: PENDING_STAMP_SCHEMA, member: "net", dir: "net", state: "/s/terraform.tfstate", failed: "choudoufu live-import -approve" });

      // --dry-run never retries the stamp.
      calls = [];
      const dry = await promoteCommand({ root, member: "net", runner: choudoufu, ledger: l, dryRun: true });
      expect(dry.retriedStamp).toBeUndefined();
      expect(calls.some((c) => c.argv.includes("-approve"))).toBe(false);
      expect(existsSync(record())).toBe(true);

      // No --state: the retry reads the state the record names.
      calls = [];
      const retried = await promoteCommand({ root, member: "net", runner: choudoufu, ledger: l });
      expect(retried).toMatchObject({ outcome: "applied", exitCode: 0, member: "net", from: "terraform", to: "choudoufu", retriedStamp: true });
      expect(retried.followUpFailed).toBeUndefined();
      // Only the staging's init and the stamp ran, in one staging directory that is not the tree's (chant#4492):
      // no live-check, no report, no chant import for the next rung.
      expect(calls.map((c) => c.argv)).toEqual([
        ["choudoufu", "init", "-input=false", "-backend=false", "-no-color"],
        ["choudoufu", "live-import", "-state=/s/terraform.tfstate", "-estate=net", "-approve"],
      ]);
      expect(calls[1]!.cwd).toBe(calls[0]!.cwd);
      expect(calls[0]!.cwd).not.toBe(join(realpathSync(root), "net"));
      expect(existsSync(calls[0]!.cwd)).toBe(false);
      expect(retried.ran).toEqual([
        { label: "choudoufu init", exitCode: 0 },
        { label: "choudoufu live-import -approve", exitCode: 0 },
      ]);
      expect(existsSync(record())).toBe(false);
      expect(kind()).toBe("choudoufu");

      // Once stamped, the next promote moves on to the next rung instead of retrying.
      calls = [];
      const next = await promoteCommand({ root, member: "net", runner: choudoufu, ledger: l, dryRun: true });
      expect(next.retriedStamp).toBeUndefined();
      expect(next.to).toBe("chant");
      expect(calls.map((c) => c.argv[0])).toEqual(["chant"]);
    });

    test("--state on the retry wins over the state the record names", async () => {
      const l = ledger();
      await promoteWithFailedStamp(l);
      calls = [];
      const retried = await promoteCommand({ root, member: "net", state: "/other/terraform.tfstate", runner: choudoufu, ledger: l });
      expect(retried.exitCode).toBe(0);
      expect(calls.at(-1)?.argv).toContain("-state=/other/terraform.tfstate");
    });

    test("a stamp that fails again stays pending and exits 1; a failing staging init keeps it pending without stamping", async () => {
      const l = ledger();
      await promoteWithFailedStamp(l);

      failStamp = true;
      calls = [];
      const again = await promoteCommand({ root, member: "net", runner: choudoufu, ledger: l });
      expect(again).toMatchObject({ outcome: "applied", exitCode: 1, retriedStamp: true, followUpFailed: "choudoufu live-import -approve" });
      expect(existsSync(record())).toBe(true);
      failStamp = false;

      failInit = true;
      calls = [];
      const noInit = await promoteCommand({ root, member: "net", runner: choudoufu, ledger: l });
      expect(noInit).toMatchObject({ outcome: "applied", exitCode: 1, retriedStamp: true, followUpFailed: "choudoufu init" });
      expect(calls.some((c) => c.argv.includes("-approve"))).toBe(false);
      expect(existsSync(record())).toBe(true);
      expect(kind()).toBe("choudoufu");
    });
  });
});
