/**
 * #5451: the Sonar, Mend and Wiz presets for `ci.hooks.check`. The scanners
 * are shell scripts on PATH that write recorded output; no vendor tool runs
 * and nothing reaches a network.
 */
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCheckHooks } from "../op/op-waves";
import { checkHookEnv, checkReportSummary, runCheckHooks } from "./check-hooks";
import { CHECK_HOOK_PRESET_NAMES, CHECK_HOOK_PRESETS, checkHookPreset } from "./check-hook-presets";
import { findingsSummaryLines, readFindings, sarifVulnFindings, summarizeSarif } from "./sarif";

const FIXTURES = join(__dirname, "__fixtures__", "scanners");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-preset-"));
  dirs.push(d);
  return d;
};

/** A fake vendor CLI: `body` is a POSIX shell script. */
function fakeTool(bin: string, name: string, body: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function fakeTools(bin: string): void {
  fakeTool(
    bin,
    "sonar-scanner",
    `echo "$@" > sonar-args.txt\nmkdir -p .scannerwork\ncp "${join(FIXTURES, "sonar-report-task.txt")}" .scannerwork/report-task.txt\nexit "\${FAKE_EXIT:-0}"`,
  );
  fakeTool(bin, "mend", `echo "$@" > mend-args.txt\nexit "\${FAKE_EXIT:-0}"`);
  fakeTool(
    bin,
    "wizcli",
    [
      `if [ "$1" = auth ]; then exit 0; fi`,
      `echo "$@" > wiz-args.txt`,
      `while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out="\${2%,sarif}"; fi; shift; done`,
      `cp "${join(FIXTURES, "fake-scanner.sarif")}" "$out"`,
      `exit "\${FAKE_EXIT:-0}"`,
    ].join("\n"),
  );
}

const VARS = ["PATH", "FAKE_EXIT", "SONAR_TOKEN", "MEND_EMAIL", "MEND_USER_KEY", "WIZ_CLIENT_ID", "WIZ_CLIENT_SECRET", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "GITHUB_ACTIONS", "GITLAB_CI", "FORGEJO_ACTIONS", "CHANT_FINDINGS"] as const;
const saved: Record<string, string | undefined> = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

/** Run `preset` through the check runner in a fresh checkout, with `env` set on the process as a job's would be. */
function runPreset(name: string, env: Record<string, string>, opts: { args?: string[] } = {}) {
  const cwd = temp();
  const bin = join(cwd, "bin");
  fakeTools(bin);
  for (const v of VARS) delete process.env[v];
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH ?? "/usr/bin:/bin"}`, ...env });
  const lines: string[] = [];
  const hook = checkHookPreset(name, opts);
  const report = runCheckHooks({ base: "abc", cwd, read: { base: "abc", hooks: [hook] }, log: (l) => lines.push(l) });
  return { cwd, report, lines };
}

const CREDENTIALS: Record<string, Record<string, string>> = {
  sonar: { SONAR_TOKEN: "sqa_fake" },
  mend: { MEND_EMAIL: "ci@example.test", MEND_USER_KEY: "key-fake" },
  wiz: { WIZ_CLIENT_ID: "id-fake", WIZ_CLIENT_SECRET: "secret-fake" },
};

describe("the presets as declaration entries", () => {
  test("each is a check hook the check job accepts, and a name that is none is refused", () => {
    for (const name of CHECK_HOOK_PRESET_NAMES) {
      const hook = checkHookPreset(name);
      expect(() => assertCheckHooks("ci.hooks", [hook])).not.toThrow();
      expect(hook).toMatchObject({ name, onFailure: "fail" });
      expect(hook.command.slice(0, 2)).toEqual(["sh", "-c"]);
    }
    expect(() => checkHookPreset("snyk")).toThrow(/sonar, mend, wiz/);
  });

  test("each names the credentials its script checks", () => {
    for (const p of Object.values(CHECK_HOOK_PRESETS)) for (const c of p.credentials) expect(p.script).toContain(c);
  });

  test("the vendors' variables pass checkHookEnv, which strips the forge and cloud credentials", () => {
    const env = checkHookEnv({ PATH: "/bin", SONAR_TOKEN: "a", MEND_USER_KEY: "b", WIZ_CLIENT_SECRET: "c", GITHUB_TOKEN: "g", AWS_SECRET_ACCESS_KEY: "s" });
    expect(env).toEqual({ PATH: "/bin", SONAR_TOKEN: "a", MEND_USER_KEY: "b", WIZ_CLIENT_SECRET: "c" });
  });
});

describe.each([
  ["GitHub", { GITHUB_ACTIONS: "true", GITHUB_TOKEN: "ghs_x" }],
  ["GitLab", { GITLAB_CI: "true" }],
  ["Forgejo", { FORGEJO_ACTIONS: "true", GITHUB_ACTIONS: "true" }],
])("on %s", (_forge, forgeEnv) => {
  test.each(CHECK_HOOK_PRESET_NAMES)("the %s preset runs through the check runner and passes", (name) => {
    const { report } = runPreset(name, { ...CREDENTIALS[name]!, ...forgeEnv });
    expect(report.status).toBe("passed");
    expect(report.hooks).toMatchObject([{ name, outcome: "passed", exit: 0 }]);
  });

  test.each(CHECK_HOOK_PRESET_NAMES)("the %s preset fails closed without its credentials, and the tool never runs", (name) => {
    const { report, cwd, lines } = runPreset(name, forgeEnv);
    expect(report.status).toBe("failed");
    expect(report.hooks[0]).toMatchObject({ outcome: "failed", exit: 78 });
    expect(report.failed).toContain(name);
    expect(lines).toBeDefined();
    const argsFile = { sonar: "sonar-args.txt", mend: "mend-args.txt", wiz: "wiz-args.txt" }[name];
    expect(() => readFileSync(join(cwd, argsFile))).toThrow();
  });
});

describe("what each preset runs and writes", () => {
  test("sonar waits for the quality gate, and its status carries the dashboard link", () => {
    const { cwd, report } = runPreset("sonar", CREDENTIALS.sonar!);
    expect(readFileSync(join(cwd, "sonar-args.txt"), "utf-8").trim()).toBe("-Dsonar.qualitygate.wait=true");
    expect(report.findings).toMatchObject([{ tool: "sonar", status: "passed", url: "https://sonar.example.test/dashboard?id=acme_api" }]);
  });

  test("a failed quality gate fails the hook and the status says failed", () => {
    const { report } = runPreset("sonar", { ...CREDENTIALS.sonar!, FAKE_EXIT: "1" });
    expect(report.status).toBe("failed");
    expect(report.hooks[0]).toMatchObject({ outcome: "failed", exit: 1 });
    expect(report.findings).toMatchObject([{ tool: "sonar", status: "failed" }]);
  });

  test("mend runs the CLI's dep scan, or the arguments the caller gives", () => {
    expect(readFileSync(join(runPreset("mend", CREDENTIALS.mend!).cwd, "mend-args.txt"), "utf-8").trim()).toBe("dep");
    expect(readFileSync(join(runPreset("mend", CREDENTIALS.mend!, { args: ["code", "--scope", "acme//api"] }).cwd, "mend-args.txt"), "utf-8").trim()).toBe("code --scope acme//api");
  });

  test("wiz writes SARIF, which the report summarizes", () => {
    const { report } = runPreset("wiz", CREDENTIALS.wiz!);
    expect(report.findings).toMatchObject([{ tool: "fake-iac-scanner", file: "wiz-iac.sarif", total: 3, counts: { error: 1, warning: 1, note: 1, none: 0 } }]);
  });
});

describe("a fake scanner's SARIF in the check report", () => {
  test("is summarized with counts, the worst findings first, and a count of the rest", () => {
    const s = summarizeSarif(fixture("fake-scanner.sarif"), "fake.sarif")!;
    expect(s.top.map((r) => [r.level, r.rule, r.location])).toEqual([["error", "FAKE-001", "infra/bucket.tf:12"], ["warning", "FAKE-002", "infra/bucket.tf:3"], ["note", "FAKE-003", undefined]]);
    expect(s.top[0]!.message).toBe("Bucket allows public reads");
  });

  test("appears in checkReportSummary, with the link of a tool that has one", () => {
    const { report } = runPreset("wiz", CREDENTIALS.wiz!);
    const text = checkReportSummary(report).join("\n");
    expect(text).toContain("#### Findings");
    expect(text).toContain("- `fake-iac-scanner`: 3 findings (1 error, 1 warning, 1 note)");
    expect(text).toContain("error: `FAKE-001` at `infra/bucket.tf:12`, Bucket allows public reads");
    const sonar = checkReportSummary(runPreset("sonar", CREDENTIALS.sonar!).report).join("\n");
    expect(sonar).toContain("- `sonar`: passed ([report](https://sonar.example.test/dashboard?id=acme_api))");
  });

  test("a file that is neither SARIF nor a status file is said so, not read as clean", () => {
    const dir = temp();
    writeFileSync(join(dir, "x.sarif"), "not json");
    writeFileSync(join(dir, "ok.sarif"), fixture("wiz-image-clean.sarif"));
    const { summaries, unreadable } = readFindings(dir);
    expect(unreadable).toEqual(["x.sarif"]);
    expect(findingsSummaryLines(summaries, unreadable).join("\n")).toContain("`x.sarif` is not SARIF");
    expect(summaries[0]).toMatchObject({ tool: "Wiz CLI", total: 0 });
  });

  test("a file from before the run is a previous run's and is left out", () => {
    const dir = temp();
    writeFileSync(join(dir, "old.sarif"), fixture("fake-scanner.sarif"));
    expect(readFindings(dir, Date.now() + 60_000).summaries).toEqual([]);
    copyFileSync(join(dir, "old.sarif"), join(dir, "new.sarif"));
    expect(readFindings(dir, 0).summaries).toHaveLength(2);
  });
});

describe("SARIF vulnerabilities for the release scan gate", () => {
  test("reads the advisory, severity, package and fix from the rule and result", () => {
    expect(sarifVulnFindings(fixture("wiz-image.sarif"))).toEqual([
      { cveId: "CVE-2026-50002", severity: "critical", package: "debian/openssl", installedVersion: "3.0.11-1", fixedVersion: "3.0.15-1", fixable: true },
      { cveId: "CVE-2026-50003", severity: "low", package: "debian/zlib", installedVersion: "1.2.13", fixable: false },
    ]);
  });

  test("falls back to the SARIF level for severity and to the message for the package", () => {
    const doc = JSON.stringify({ runs: [{ tool: { driver: { name: "x" } }, results: [{ ruleId: "CVE-1", level: "error", message: { text: "Found in package curl 8.0.1" } }] }] });
    expect(sarifVulnFindings(doc)).toEqual([{ cveId: "CVE-1", severity: "high", package: "curl", installedVersion: "8.0.1", fixable: false }]);
  });

  test("refuses text that is not SARIF", () => {
    expect(() => sarifVulnFindings("{}")).toThrow(/not a SARIF/);
  });
});
