/**
 * choudoufu-specific activity tests (#2103): the three new activities, the
 * `terraformApply` live-root branch, and the version check. Same
 * `node:child_process` mock as `terraform.test.ts`; nothing here runs
 * choudoufu or terraform.
 */

import { describe, test, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  terraformApply,
  choudoufuLivePlan,
  choudoufuLiveLs,
  choudoufuLiveCheck,
  choudoufuAdopt,
  choudoufuLiveApplyCommand,
  choudoufuLivePlanCommand,
  choudoufuLiveLsCommand,
  choudoufuLiveCheckCommand,
  countLivePlanUnowned,
  isOlderVersion,
  parseChoudoufuVersion,
  __resetChoudoufuVersionCheckForTests,
  DEFAULT_LIVE_PLAN_DOCUMENT_FILE,
  MIN_CHOUDOUFU_VERSION,
} from "./terraform";

// ── The child-process stub (mirrors terraform.test.ts) ──────────────────────

interface ExecCall {
  cmd: string;
  opts: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal };
}

const execCalls: ExecCall[] = [];

type Reply = { stdout: string; stderr: string } | Error;
let replies: Array<{ match: string; reply: Reply }> = [];

function execError(code: number, stderr: string, stdout = ""): Error & { code: number; stdout: string; stderr: string } {
  return Object.assign(new Error(`Command failed (exit ${code})`), { code, stdout, stderr });
}

/** Every exec call's command, excluding the `choudoufu version` check every activity call triggers once. */
function commandsRun(): string[] {
  return execCalls.filter((c) => c.cmd !== "choudoufu version").map((c) => c.cmd);
}

vi.mock("node:child_process", () => {
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const exec = ((_cmd: string, _opts: unknown, cb?: (...a: unknown[]) => void) => {
    cb?.(new Error("unmocked exec path"));
  }) as unknown as Record<symbol, unknown>;
  exec[custom] = async (cmd: string, opts?: ExecCall["opts"]) => {
    execCalls.push({ cmd, opts: opts ?? {} });
    for (const { match, reply } of replies) {
      if (cmd.includes(match)) {
        if (reply instanceof Error) throw reply;
        return reply;
      }
    }
    return { stdout: "", stderr: "" };
  };
  return { exec };
});

// ── A real project config to resolve roots against ──────────────────────────

const workspaces: string[] = [];

/** Write a throwaway project with a `terraform` namespace and a live root directory. */
function liveProject(opts: { withLiveBlock?: boolean; withSidecar?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-tf-choudoufu-"));
  workspaces.push(dir);
  const rootDir = join(dir, "estate");
  mkdirSync(rootDir, { recursive: true });

  if (opts.withSidecar) {
    writeFileSync(join(rootDir, "estate.chdf.hcl"), 'estate = "prod-networking"\n');
    writeFileSync(join(rootDir, "main.tf"), 'resource "null_resource" "x" {}\n');
  } else if (opts.withLiveBlock !== false) {
    writeFileSync(
      join(rootDir, "main.tf"),
      ["terraform {", "  live {", '    estate = "prod-networking"', "  }", "}", "", 'resource "null_resource" "x" {}', ""].join(
        "\n",
      ),
    );
  } else {
    writeFileSync(join(rootDir, "main.tf"), 'resource "null_resource" "x" {}\n');
  }

  writeFileSync(
    join(dir, "chant.config.json"),
    JSON.stringify({ lexicons: ["terraform"], terraform: { binary: "choudoufu", roots: { estate: { dir: "./estate" } } } }, null, 2),
  );
  return dir;
}

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  execCalls.length = 0;
  replies = [];
  __resetChoudoufuVersionCheckForTests();
});

afterEach(() => {
  __resetChoudoufuVersionCheckForTests();
});

// ── Pure command builders ────────────────────────────────────────────────────

describe("choudoufuLiveApplyCommand (#2103)", () => {
  test("apply -auto-approve, no plan file", () => {
    expect(choudoufuLiveApplyCommand({ binary: "choudoufu" })).toBe("choudoufu apply -input=false -auto-approve");
  });
});

describe("choudoufuLivePlanCommand (#2103)", () => {
  test("json form carries -detailed-exitcode, -json and -estate", () => {
    expect(choudoufuLivePlanCommand({ binary: "choudoufu", estate: "prod", json: true })).toBe(
      "choudoufu live-plan -detailed-exitcode -json -estate=prod",
    );
  });

  test("text form omits -json", () => {
    expect(choudoufuLivePlanCommand({ binary: "choudoufu", estate: "prod", json: false })).toBe(
      "choudoufu live-plan -detailed-exitcode -estate=prod",
    );
  });

  test("an estate needing shell quoting is quoted", () => {
    expect(choudoufuLivePlanCommand({ binary: "choudoufu", estate: "has space", json: true })).toContain(
      "-estate='has space'",
    );
  });

  test("-adoption-only and -no-color ride the human form (#2105)", () => {
    expect(
      choudoufuLivePlanCommand({ binary: "choudoufu", estate: "prod", json: false, adoptionOnly: true, noColor: true }),
    ).toBe("choudoufu live-plan -detailed-exitcode -adoption-only -no-color -estate=prod");
  });

  test("-adoption-only with -json is refused here, as choudoufu refuses it (#2105)", () => {
    expect(() =>
      choudoufuLivePlanCommand({ binary: "choudoufu", estate: "prod", json: true, adoptionOnly: true }),
    ).toThrow(/cannot be combined/);
  });
});

describe("choudoufuLiveLsCommand (#2103)", () => {
  test("carries -estate and -json", () => {
    expect(choudoufuLiveLsCommand({ binary: "choudoufu", estate: "prod" })).toBe(
      "choudoufu live-ls -estate=prod -json",
    );
  });

  test("-consistent is opt-in", () => {
    expect(choudoufuLiveLsCommand({ binary: "choudoufu", estate: "prod", consistent: true })).toBe(
      "choudoufu live-ls -estate=prod -json -consistent",
    );
  });
});

describe("choudoufuLiveCheckCommand (#2103)", () => {
  test("live-check -json, no DIR argument", () => {
    expect(choudoufuLiveCheckCommand({ binary: "choudoufu" })).toBe("choudoufu live-check -json");
  });
});

describe("countLivePlanUnowned (#2103)", () => {
  test("counts unowned entries and the adoptable subset", () => {
    const doc = {
      unowned: [
        { addr: "aws_vpc.a", adopt_tofu_estate: "prod", adopt_tofu_address: "aws_vpc.a" },
        { addr: "aws_vpc.b" },
        { addr: "aws_vpc.c", adopt_tofu_address: "aws_vpc.c" },
      ],
    };
    expect(countLivePlanUnowned(doc)).toEqual({ unowned: 3, adoptable: 2 });
  });

  test("zero when the document has no unowned array", () => {
    expect(countLivePlanUnowned({})).toEqual({ unowned: 0, adoptable: 0 });
    expect(countLivePlanUnowned(null)).toEqual({ unowned: 0, adoptable: 0 });
  });
});

describe("isOlderVersion / parseChoudoufuVersion (#2103)", () => {
  test("compares major.minor.patch numerically", () => {
    expect(isOlderVersion("0.11.9", "0.12.0")).toBe(true);
    expect(isOlderVersion("0.12.0", "0.12.0")).toBe(false);
    expect(isOlderVersion("0.12.1", "0.12.0")).toBe(false);
    expect(isOlderVersion("1.0.0", "0.12.0")).toBe(false);
  });

  test("parses the release version out of the human `version` output", () => {
    expect(parseChoudoufuVersion("choudoufu v0.12.0 (based on OpenTofu v1.13.0)\non darwin_arm64")).toBe("0.12.0");
  });

  test("undefined for a dev build with no release tag baked in", () => {
    expect(parseChoudoufuVersion("OpenTofu v1.13.0-dev\non darwin_arm64")).toBeUndefined();
  });
});

// ── The version check, wired into every activity via resolveRoot ───────────

describe("choudoufu version check (#2103)", () => {
  test("refuses a binary older than v0.12.0", async () => {
    const dir = liveProject();
    replies.push({ match: "version", reply: { stdout: "choudoufu v0.11.0 (based on OpenTofu v1.12.0)\n", stderr: "" } });
    await expect(choudoufuLiveCheck({ root: "estate", cwd: dir })).rejects.toThrow(/older than.*v0\.12\.0/);
  });

  test("passes at exactly the minimum version", async () => {
    const dir = liveProject();
    replies.push({
      match: "version",
      reply: { stdout: `choudoufu v${MIN_CHOUDOUFU_VERSION} (based on OpenTofu v1.13.0)\n`, stderr: "" },
    });
    replies.push({ match: "live-check", reply: { stdout: "{}", stderr: "" } });
    await expect(choudoufuLiveCheck({ root: "estate", cwd: dir })).resolves.toBeDefined();
  });

  test("runs once per module load, not once per activity call", async () => {
    const dir = liveProject();
    replies.push({
      match: "version",
      reply: { stdout: `choudoufu v${MIN_CHOUDOUFU_VERSION} (based on OpenTofu v1.13.0)\n`, stderr: "" },
    });
    replies.push({ match: "live-check", reply: { stdout: "{}", stderr: "" } });
    await choudoufuLiveCheck({ root: "estate", cwd: dir });
    await choudoufuLiveCheck({ root: "estate", cwd: dir });
    const versionCalls = execCalls.filter((c) => c.cmd === "choudoufu version");
    expect(versionCalls).toHaveLength(1);
  });

  test("a dev build with no parsable release version is never refused", async () => {
    const dir = liveProject();
    replies.push({ match: "version", reply: { stdout: "OpenTofu v1.13.0-dev\non darwin_arm64\n", stderr: "" } });
    replies.push({ match: "live-check", reply: { stdout: "{}", stderr: "" } });
    await expect(choudoufuLiveCheck({ root: "estate", cwd: dir })).resolves.toBeDefined();
  });
});

// ── terraformApply on a live root ───────────────────────────────────────────

describe("terraformApply on a live root (#2103)", () => {
  test("runs apply -auto-approve with no plan file", async () => {
    const dir = liveProject();
    const result = await terraformApply({ root: "estate", cwd: dir });
    const applyCalls = execCalls.filter((c) => c.cmd.includes("apply"));
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].cmd).toBe("choudoufu apply -input=false -auto-approve");
    expect(result).toEqual({ dir: resolve(dir, "estate"), applied: true });
  });

  test("refuses a plan file, quoting choudoufu's own reason", async () => {
    const dir = liveProject();
    await expect(terraformApply({ root: "estate", cwd: dir, planFile: "chant.tfplan" })).rejects.toThrow(
      /Applying a saved plan file is not available under live resource markers/,
    );
    expect(execCalls.filter((c) => c.cmd.includes("apply"))).toHaveLength(0);
  });

  test("reads the estate from the sidecar just as well", async () => {
    const dir = liveProject({ withSidecar: true });
    await terraformApply({ root: "estate", cwd: dir });
    expect(execCalls.some((c) => c.cmd === "choudoufu apply -input=false -auto-approve")).toBe(true);
  });

  test("a choudoufu root with no live declaration runs the ordinary stock branch", async () => {
    const dir = liveProject({ withLiveBlock: false });
    await expect(terraformApply({ root: "estate", cwd: dir })).rejects.toThrow(/planFile is required/);
  });
});

// ── choudoufuLivePlan ────────────────────────────────────────────────────────

describe("choudoufuLivePlan (#2103)", () => {
  const DOC = JSON.stringify({
    estate: "prod-networking",
    bound: [],
    omissions: [],
    unowned: [{ addr: "aws_vpc.solo", adopt_tofu_address: "aws_vpc.solo" }],
  });

  test("exit 0: no drift, the document is captured and written, the human plan comes from a second call", async () => {
    const dir = liveProject();
    replies.push({ match: "live-plan -detailed-exitcode -json", reply: { stdout: DOC, stderr: "" } });
    replies.push({ match: "live-plan -detailed-exitcode -no-color -estate", reply: { stdout: "No changes.\n", stderr: "" } });

    const result = await choudoufuLivePlan({ root: "estate", cwd: dir });
    expect(result.drift).toBe(false);
    expect(result.estate).toBe("prod-networking");
    expect(result.json).toEqual(JSON.parse(DOC));
    expect(result.text).toBe("No changes.\n");
    expect(result.unowned).toBe(1);
    expect(result.adoptable).toBe(1);
    expect(result.documentPath).toBe(DEFAULT_LIVE_PLAN_DOCUMENT_FILE);

    const written = readFileSync(join(result.dir, DEFAULT_LIVE_PLAN_DOCUMENT_FILE), "utf-8");
    expect(JSON.parse(written)).toEqual(JSON.parse(DOC));

    expect(commandsRun()).toEqual([
      "choudoufu live-plan -detailed-exitcode -json -estate=prod-networking",
      "choudoufu live-plan -detailed-exitcode -no-color -estate=prod-networking",
    ]);
  });

  test("exit 2: drift, and the document is still captured", async () => {
    const dir = liveProject();
    replies.push({ match: "live-plan -detailed-exitcode -json", reply: execError(2, "", DOC) });
    replies.push({ match: "live-plan -detailed-exitcode -no-color -estate", reply: { stdout: "Plan: 1 to add.\n", stderr: "" } });

    const result = await choudoufuLivePlan({ root: "estate", cwd: dir });
    expect(result.drift).toBe(true);
    expect(result.json).toEqual(JSON.parse(DOC));
  });

  test("exit 1: throws with choudoufu's stderr attached", async () => {
    const dir = liveProject();
    replies.push({ match: "live-plan -detailed-exitcode -json", reply: execError(1, "Error: something refused") });
    await expect(choudoufuLivePlan({ root: "estate", cwd: dir })).rejects.toThrow(
      /live-plan failed.*exit 1[\s\S]*something refused/,
    );
  });

  test("an explicit estate overrides auto-detection", async () => {
    const dir = liveProject();
    replies.push({ match: "live-plan -detailed-exitcode -json", reply: { stdout: DOC, stderr: "" } });
    replies.push({ match: "live-plan -detailed-exitcode -no-color -estate", reply: { stdout: "", stderr: "" } });
    await choudoufuLivePlan({ root: "estate", cwd: dir, estate: "other-estate" });
    expect(commandsRun()[0]).toContain("-estate=other-estate");
  });

  test("no estate anywhere: refused, and the plan itself never runs", async () => {
    const dir = liveProject({ withLiveBlock: false });
    await expect(choudoufuLivePlan({ root: "estate", cwd: dir })).rejects.toThrow(/no estate to run against/);
    expect(commandsRun()).toHaveLength(0);
  });
});

// ── choudoufuLivePlan's adoption ledger (#2105) ──────────────────────────────

describe("choudoufuLivePlan adoption ledger (#2105)", () => {
  const ADOPTABLE = JSON.stringify({
    estate: "prod-networking",
    bound: [{ addr: "aws_subnet.app", identity: "subnet-99" }],
    omissions: [],
    unowned: [
      {
        addr: "aws_vpc.main",
        type: "aws_vpc",
        identity: "vpc-0abc",
        adopt_tofu_estate: "prod-networking",
        adopt_tofu_address: "aws_vpc.main",
      },
    ],
  });

  const LEDGER_RENDER = [
    "Adoptable now: 1 resource instance",
    "",
    "  aws_vpc.main <- aws_vpc vpc-0abc",
    "      adopt with: aws ec2 create-tags --resources 'vpc-0abc' --tags 'Key=tofu-estate,Value=prod-networking'",
    "      or write: tofu-estate=prod-networking tofu-address=aws_vpc.main",
    "",
  ].join("\n");

  test("every run projects the document into a ledger, adoptions and contested", async () => {
    const dir = liveProject();
    replies.push({ match: "live-plan -detailed-exitcode -json", reply: { stdout: ADOPTABLE, stderr: "" } });
    replies.push({
      match: "live-plan -detailed-exitcode -no-color -estate",
      reply: { stdout: "Plan: 1 to add.\n", stderr: "" },
    });

    const result = await choudoufuLivePlan({ root: "estate", cwd: dir });
    expect(result.adoptions.map((c) => c.addr)).toEqual(["aws_vpc.main"]);
    expect(result.contested).toEqual([]);
    expect(result.ambiguous).toBe(0);
    expect(result.ledger).toContain(
      "  aws_vpc.main <- aws_vpc vpc-0abc  write: tofu-estate=prod-networking tofu-address=aws_vpc.main",
    );
  });

  test("`finding` is the plan text and then the ledger, and carries no JSON", async () => {
    const dir = liveProject();
    replies.push({ match: "live-plan -detailed-exitcode -json", reply: { stdout: ADOPTABLE, stderr: "" } });
    replies.push({
      match: "live-plan -detailed-exitcode -no-color -estate",
      reply: { stdout: "Plan: 1 to add.\n", stderr: "" },
    });

    const result = await choudoufuLivePlan({ root: "estate", cwd: dir });
    expect(result.finding.startsWith("Plan: 1 to add.")).toBe(true);
    expect(result.finding).toContain("Adoptable now: 1 live resource");
    // The document's bound section names a resource the ledger has no reason
    // to mention; if any of the JSON leaked into `finding`, this is where.
    expect(result.finding).not.toContain("subnet-99");
    expect(result.finding).not.toContain("adopt_tofu_address");
  });

  test("adoptionOnly renders the human half as choudoufu's ledger and reads its commands", async () => {
    const dir = liveProject();
    replies.push({ match: "live-plan -detailed-exitcode -json", reply: { stdout: ADOPTABLE, stderr: "" } });
    replies.push({ match: "-adoption-only", reply: { stdout: LEDGER_RENDER, stderr: "" } });

    const result = await choudoufuLivePlan({ root: "estate", cwd: dir, adoptionOnly: true });
    expect(commandsRun()).toEqual([
      "choudoufu live-plan -detailed-exitcode -json -estate=prod-networking",
      "choudoufu live-plan -detailed-exitcode -adoption-only -no-color -estate=prod-networking",
    ]);
    expect(result.adoptions[0].command).toBe(
      "aws ec2 create-tags --resources 'vpc-0abc' --tags 'Key=tofu-estate,Value=prod-networking'",
    );
  });

  test("without adoptionOnly a candidate carries the marker values and no command", async () => {
    const dir = liveProject();
    replies.push({ match: "live-plan -detailed-exitcode -json", reply: { stdout: ADOPTABLE, stderr: "" } });
    replies.push({ match: "live-plan -detailed-exitcode -no-color -estate", reply: { stdout: "", stderr: "" } });

    const result = await choudoufuLivePlan({ root: "estate", cwd: dir });
    expect(result.adoptions[0].command).toBeUndefined();
    expect(result.adoptions[0].markerAddress).toBe("aws_vpc.main");
  });
});

// ── choudoufuAdopt (#2105) ───────────────────────────────────────────────────

describe("choudoufuAdopt (#2105)", () => {
  const candidate = (addr: string, identity: string, command?: string) => ({
    addr,
    type: "aws_vpc",
    identity,
    markerEstate: "prod-networking",
    markerAddress: addr,
    ...(command ? { command } : {}),
  });

  test("runs each candidate's own tagging command, in the root directory", async () => {
    const dir = liveProject();
    const result = await choudoufuAdopt({
      root: "estate",
      cwd: dir,
      adoptions: [
        candidate("aws_vpc.main", "vpc-0abc", "aws ec2 create-tags --resources 'vpc-0abc'"),
        candidate("aws_subnet.app", "subnet-01", "aws ec2 create-tags --resources 'subnet-01'"),
      ],
    });
    expect(result.mechanism).toBe("tag-write");
    expect(result.adopted).toEqual(["aws_vpc.main", "aws_subnet.app"]);
    expect(result.adoptedCount).toBe(2);
    expect(commandsRun()).toEqual([
      "aws ec2 create-tags --resources 'vpc-0abc'",
      "aws ec2 create-tags --resources 'subnet-01'",
    ]);
    expect(
      execCalls.filter((c) => c.cmd !== "choudoufu version").every((c) => c.opts.cwd === resolve(dir, "estate")),
    ).toBe(true);
  });

  test("a candidate with no printed command is refused, naming both marker values", async () => {
    const dir = liveProject();
    const result = await choudoufuAdopt({
      root: "estate",
      cwd: dir,
      adoptions: [candidate("aws_iam_role.app", "app-role")],
    });
    expect(result.adopted).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].reason).toContain("tofu-estate=prod-networking");
    expect(result.refused[0].reason).toContain("tofu-address=aws_iam_role.app");
    expect(commandsRun()).toEqual([]);
  });

  test("a contested candidate is reported and never written", async () => {
    const dir = liveProject();
    const result = await choudoufuAdopt({
      root: "estate",
      cwd: dir,
      adoptions: [],
      contested: [
        candidate("aws_vpc.main", "vpc-0abc", "aws ec2 create-tags --resources 'vpc-0abc'"),
        candidate("aws_vpc.main", "vpc-0def", "aws ec2 create-tags --resources 'vpc-0def'"),
      ],
    });
    expect(result.adopted).toEqual([]);
    expect(result.ambiguous).toBe(1);
    expect(result.refused.map((r) => r.identity)).toEqual(["vpc-0abc", "vpc-0def"]);
    expect(result.refused[0].reason).toContain("more than one live resource");
    // A contested candidate carries a command; running it anyway is the whole
    // thing this refuses to do.
    expect(commandsRun()).toEqual([]);
  });

  test("nothing to adopt runs nothing and fails nothing", async () => {
    const dir = liveProject();
    const result = await choudoufuAdopt({ root: "estate", cwd: dir, adoptions: [] });
    expect(result).toMatchObject({ adopted: [], adoptedCount: 0, refused: [], ambiguous: 0 });
    expect(commandsRun()).toEqual([]);
  });
});

// ── choudoufuLiveLs ──────────────────────────────────────────────────────────

describe("choudoufuLiveLs (#2103)", () => {
  test("lists the estate as JSON", async () => {
    const dir = liveProject();
    const listing = JSON.stringify([{ arn: "arn:aws:ec2:...:vpc/vpc-1", type: "aws_vpc", address: "aws_vpc.main" }]);
    replies.push({ match: "live-ls", reply: { stdout: listing, stderr: "" } });

    const result = await choudoufuLiveLs({ root: "estate", cwd: dir });
    expect(result.estate).toBe("prod-networking");
    expect(result.json).toEqual(JSON.parse(listing));
    expect(commandsRun()).toEqual(["choudoufu live-ls -estate=prod-networking -json"]);
  });

  test("-consistent is forwarded", async () => {
    const dir = liveProject();
    replies.push({ match: "live-ls", reply: { stdout: "[]", stderr: "" } });
    await choudoufuLiveLs({ root: "estate", cwd: dir, consistent: true });
    expect(commandsRun()[0]).toContain("-consistent");
  });
});

// ── choudoufuLiveCheck ───────────────────────────────────────────────────────

describe("choudoufuLiveCheck (#2103)", () => {
  test("exit 0: not refused", async () => {
    const dir = liveProject();
    replies.push({ match: "live-check", reply: { stdout: '{"instances":[]}', stderr: "" } });
    const result = await choudoufuLiveCheck({ root: "estate", cwd: dir });
    expect(result.refused).toBe(false);
    expect(result.json).toEqual({ instances: [] });
    expect(commandsRun()).toEqual(["choudoufu live-check -json"]);
  });

  test("non-zero exit: refused, not thrown, and the output is still captured", async () => {
    const dir = liveProject();
    replies.push({ match: "live-check", reply: execError(1, "", '{"instances":[{"refused":true}]}') });
    const result = await choudoufuLiveCheck({ root: "estate", cwd: dir });
    expect(result.refused).toBe(true);
    expect(result.json).toEqual({ instances: [{ refused: true }] });
  });

  test("runs with no estate at all: live-check needs none", async () => {
    const dir = liveProject({ withLiveBlock: false });
    replies.push({ match: "live-check", reply: { stdout: "{}", stderr: "" } });
    const result = await choudoufuLiveCheck({ root: "estate", cwd: dir });
    expect(result.refused).toBe(false);
  });
});

describe("liveDocumentFrom (choudoufu #894)", () => {
  test("skips refresh progress lines that precede the document", async () => {
    const { liveDocumentFrom } = await import("./terraform");
    const stdout = 'aws_vpc.main: Refreshing state... [id=vpc-1]\naws_subnet.a: Refreshing state...\n{\n  "bound": []\n}\n';
    expect(JSON.parse(liveDocumentFrom(stdout))).toEqual({ bound: [] });
  });
  test("returns a clean document unchanged", async () => {
    const { liveDocumentFrom } = await import("./terraform");
    expect(liveDocumentFrom('{\n  "bound": []\n}\n')).toBe('{\n  "bound": []\n}\n');
  });
  test("returns the input unchanged when no line opens a document, so JSON.parse reports the real text", async () => {
    const { liveDocumentFrom } = await import("./terraform");
    expect(liveDocumentFrom("Error: boom\n")).toBe("Error: boom\n");
  });
});
