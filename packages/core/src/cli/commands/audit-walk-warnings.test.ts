import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditCommand, printAuditResult, type AuditCommandOptions } from "./audit";
import { loadAuditPlugins } from "../../audit/discover";

/**
 * #2528's warning release. `chant audit` warns on stderr about the two changes
 * the next release makes (#2525's exception list), and the report itself stays
 * byte-identical: every test here that runs with a warning also runs the same
 * tree without its cause and compares the JSON.
 */

const NOW = "2026-09-23T00:00:00.000Z";
const dirs: string[] = [];

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-2528-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

let plugins: Awaited<ReturnType<typeof loadAuditPlugins>>;

// Loading every audit lexicon is the slow part; once, outside any one test's timeout.
beforeAll(async () => {
  plugins = await loadAuditPlugins();
}, 120_000);

function audit(path: string, extra: Partial<AuditCommandOptions> = {}) {
  return auditCommand({ path, format: "json", now: NOW, toolVersion: "0.0.0", plugins, ...extra });
}

/** Print a result the way the CLI does, and split what reached each stream. */
function printed(result: Awaited<ReturnType<typeof auditCommand>>): { stdout: string; stderr: string } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(s));
  printAuditResult(result);
  vi.restoreAllMocks();
  return { stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("a truncated walk is warned about, not yet reported (#2528)", () => {
  function treeWithTail(): string {
    const dir = tmpRepo();
    mkdirSync(join(dir, "a"), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, "a", `${i}.md`), "x");
    writeFileSync(join(dir, "a", "terraform.tfstate"), "{}");
    // Past the limit: a state file TF023 would report if the walk reached it.
    mkdirSync(join(dir, "z"), { recursive: true });
    writeFileSync(join(dir, "z", "terraform.tfstate"), "{}");
    return dir;
  }

  test("the warning names the limit and --max-files, on stderr only", async () => {
    const dir = treeWithTail();
    const result = await audit(dir, { maxFiles: 6 });
    expect(result.warnings).toHaveLength(1);
    const { stdout, stderr } = printed(result);
    expect(stdout).toBe(result.output);
    expect(stderr).toContain(`the scan of ${dir} stopped at 6 files, so part of the tree was not audited.`);
    expect(stderr).toContain("Raise it with --max-files <n>.");
    expect(stderr).toContain("From the next release, text and JSON output will also report a truncated scan.");
    expect(result.findings.map((f) => f.file)).toEqual(["a/terraform.tfstate"]);
  });

  test("the JSON and text reports are what the same tree gives without the files past the limit", async () => {
    const dir = treeWithTail();
    const truncatedJson = await audit(dir, { maxFiles: 6 });
    const truncatedText = await audit(dir, { maxFiles: 6, format: "stylish" });
    rmSync(join(dir, "z"), { recursive: true, force: true });
    const wholeJson = await audit(dir, { maxFiles: 6 });
    const wholeText = await audit(dir, { maxFiles: 6, format: "stylish" });
    expect(wholeJson.warnings).toBeUndefined();
    expect(truncatedJson.output).toBe(wholeJson.output);
    expect(truncatedText.output).toBe(wholeText.output);
    expect(printed(truncatedJson).stdout).toBe(printed(wholeJson).stdout);
  });

  test("--max-files raises the limit, and the default walk does not warn on a small tree", async () => {
    const dir = treeWithTail();
    const raised = await audit(dir, { maxFiles: 7 });
    expect(raised.warnings).toBeUndefined();
    expect(raised.findings.map((f) => f.file).sort()).toEqual(["a/terraform.tfstate", "z/terraform.tfstate"]);
    expect((await audit(dir)).warnings).toBeUndefined();
  });
});

describe("TF023 warns when a nested .gitignore would change its finding (#2528)", () => {
  function nestedTree(nested: string | undefined): string {
    const dir = tmpRepo();
    mkdirSync(join(dir, "infra"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    writeFileSync(join(dir, "infra", "main.tf"), 'resource "null_resource" "a" {}\n');
    writeFileSync(join(dir, "infra", "terraform.tfstate"), "{}");
    if (nested !== undefined) writeFileSync(join(dir, "infra", ".gitignore"), nested);
    return dir;
  }

  test("fires for the file a nested .gitignore ignores, naming both, and TF023 still reports it", async () => {
    const dir = nestedTree("*.tfstate\n");
    const result = await audit(dir);
    expect(result.findings.filter((f) => f.checkId === "TF023").map((f) => f.file)).toEqual(["infra/terraform.tfstate"]);
    expect(result.warnings).toEqual([
      {
        file: "infra/terraform.tfstate",
        message: "TF023 reports this path because chant audit reads only the root .gitignore, but infra/.gitignore ignores it.",
        hint: "From the next release chant audit reads every .gitignore between a file and the scan root, and TF023 will no longer report this path.",
      },
    ]);
    const { stdout, stderr } = printed(result);
    expect(stdout).toBe(result.output);
    expect(stderr).toContain("infra/terraform.tfstate");
    expect(stderr).toContain("infra/.gitignore ignores it");
  });

  test("does not fire when the nested .gitignore does not cover the file", async () => {
    const result = await audit(nestedTree("*.log\n"));
    expect(result.findings.some((f) => f.checkId === "TF023")).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  test("does not fire when the root .gitignore already drops the file", async () => {
    const dir = nestedTree("*.tfstate\n");
    writeFileSync(join(dir, ".gitignore"), "*.tfstate\n");
    const result = await audit(dir);
    expect(result.findings.some((f) => f.checkId === "TF023")).toBe(false);
    expect(result.warnings).toBeUndefined();
  });

  test("stdout JSON and the text report are byte-identical with and without the nested .gitignore", async () => {
    const dir = nestedTree("*.tfstate\n");
    const withJson = await audit(dir);
    const withText = await audit(dir, { format: "stylish" });
    const withSarif = await audit(dir, { format: "sarif" });
    rmSync(join(dir, "infra", ".gitignore"));
    const withoutJson = await audit(dir);
    const withoutText = await audit(dir, { format: "stylish" });
    const withoutSarif = await audit(dir, { format: "sarif" });
    expect(withJson.warnings).toHaveLength(1);
    expect(withoutJson.warnings).toBeUndefined();
    expect(withJson.output).toBe(withoutJson.output);
    expect(withText.output).toBe(withoutText.output);
    expect(withSarif.output).toBe(withoutSarif.output);
    expect(printed(withJson).stdout).toBe(printed(withoutJson).stdout);
    JSON.parse(printed(withJson).stdout);
  });
});
