import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditCommand, printAuditResult, type AuditCommandOptions } from "./audit";
import { loadAuditPlugins } from "../../audit/discover";

/**
 * #2528, one of the level-0 changes on #2525's exception list (warned in
 * v0.80.0). A truncated local walk is stated in the report, with its limit and
 * the flag that raises it, and TF023 honours every `.gitignore` between a path
 * and the scan root.
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

describe("a truncated walk is reported (#2528)", () => {
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

  test("JSON carries truncated with the limit and the flag, and nothing goes to stderr", async () => {
    const dir = treeWithTail();
    const result = await audit(dir, { maxFiles: 6 });
    expect(JSON.parse(result.output).truncated).toEqual({ limit: 6, flag: "--max-files" });
    expect(result.warnings).toBeUndefined();
    const { stdout, stderr } = printed(result);
    expect(stdout).toBe(result.output);
    expect(stderr).toBe("");
    expect(result.findings.map((f) => f.file)).toEqual(["a/terraform.tfstate"]);
  });

  test("the text report leads with a note naming the limit and --max-files", async () => {
    const dir = treeWithTail();
    const result = await audit(dir, { maxFiles: 6, format: "stylish" });
    const first = result.output.split("\n")[0];
    expect(first).toBe(
      `Note: The scan of ${dir} stopped at 6 files, so part of the tree was not audited. ` +
        "The limit counts every file the walk reaches, not only the ones it audits. Raise it with --max-files <n>.",
    );
    expect(result.warnings).toBeUndefined();
  });

  test("markdown and HTML carry the note, and HTML's embedded JSON carries the field", async () => {
    const dir = treeWithTail();
    const md = await audit(dir, { maxFiles: 6, format: "markdown" });
    expect(md.output).toContain("stopped at 6 files");
    const html = await audit(dir, { maxFiles: 6, format: "html" });
    expect(html.output).toContain("stopped at 6 files");
    expect(html.output).toContain('"truncated":{"limit":6,"flag":"--max-files"}');
  });

  test("SARIF has no slot for it, so the truncation goes to stderr there", async () => {
    const dir = treeWithTail();
    const result = await audit(dir, { maxFiles: 6, format: "sarif" });
    const { stdout, stderr } = printed(result);
    expect(stdout).toBe(result.output);
    expect(stderr).toContain(`The scan of ${dir} stopped at 6 files`);
    expect(stderr).toContain("--max-files <n>");
  });

  test("a whole scan reports nothing: no field, no note", async () => {
    const dir = treeWithTail();
    const raised = await audit(dir, { maxFiles: 7 });
    expect(JSON.parse(raised.output)).not.toHaveProperty("truncated");
    expect(raised.warnings).toBeUndefined();
    expect(raised.findings.map((f) => f.file).sort()).toEqual(["a/terraform.tfstate", "z/terraform.tfstate"]);
    const text = await audit(dir, { format: "stylish" });
    expect(text.output).not.toContain("stopped at");
  });

  test("the no-lexicons report states it too", async () => {
    const dir = treeWithTail();
    const json = await audit(dir, { maxFiles: 6, plugins: [] });
    expect(JSON.parse(json.output).truncated).toEqual({ limit: 6, flag: "--max-files" });
    const text = await audit(dir, { maxFiles: 6, plugins: [], format: "stylish" });
    expect(text.output).toContain("stopped at 6 files");
  });

  test("an audit with nothing auditable still says the scan was cut short", async () => {
    const dir = tmpRepo();
    for (let i = 0; i < 4; i++) writeFileSync(join(dir, `${i}.md`), "x");
    const result = await audit(dir, { maxFiles: 2, format: "stylish" });
    expect(result.output).toContain("No auditable files found");
    expect(result.output).toContain("stopped at 2 files");
  });
});

describe("TF023 honours every .gitignore between a path and the scan root (#2528)", () => {
  function nestedTree(nested: string | undefined): string {
    const dir = tmpRepo();
    mkdirSync(join(dir, "infra", "prod"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    writeFileSync(join(dir, "infra", "main.tf"), 'resource "null_resource" "a" {}\n');
    writeFileSync(join(dir, "infra", "terraform.tfstate"), "{}");
    writeFileSync(join(dir, "infra", "prod", "terraform.tfstate"), "{}");
    if (nested !== undefined) writeFileSync(join(dir, "infra", ".gitignore"), nested);
    return dir;
  }
  const tf023 = (r: Awaited<ReturnType<typeof audit>>) =>
    r.findings.filter((f) => f.checkId === "TF023").map((f) => f.file).sort();

  test("a nested .gitignore drops the paths it covers, at any depth below it", async () => {
    const result = await audit(nestedTree("*.tfstate\n"));
    expect(tf023(result)).toEqual([]);
    expect(result.warnings).toBeUndefined();
  });

  test("a nested .gitignore that does not cover the file changes nothing", async () => {
    expect(tf023(await audit(nestedTree("*.log\n")))).toEqual(["infra/prod/terraform.tfstate", "infra/terraform.tfstate"]);
  });

  test("a .gitignore deeper than the file does not apply to it", async () => {
    const dir = nestedTree(undefined);
    writeFileSync(join(dir, "infra", "prod", ".gitignore"), "*.tfstate\n");
    expect(tf023(await audit(dir))).toEqual(["infra/terraform.tfstate"]);
  });

  test("auditing from the root and from the subdirectory agree", async () => {
    const dir = nestedTree(undefined);
    writeFileSync(join(dir, "infra", "prod", ".gitignore"), "*.tfstate\n");
    const fromRoot = tf023(await audit(dir));
    const fromInfra = tf023(await audit(join(dir, "infra"))).map((p) => `infra/${p}`);
    expect(fromRoot).toEqual(fromInfra);
  });
});
