import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditCommand, readEnabledRules } from "./audit";
import { loadAuditPlugins } from "../../audit/discover";

/**
 * #3190: TF040 is an `auditOptIn` check. `chant audit` leaves it out unless the
 * project's `lint.rules` names it, so level-0 audit output does not change.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let plugins: Awaited<ReturnType<typeof loadAuditPlugins>>;
beforeAll(async () => {
  plugins = await loadAuditPlugins();
}, 120_000);

function project(config?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-3190-"));
  dirs.push(dir);
  writeFileSync(join(dir, "main.tf"), 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n');
  if (config) writeFileSync(join(dir, "chant.config.json"), JSON.stringify(config));
  return dir;
}

async function ids(dir: string): Promise<string[]> {
  const r = await auditCommand({ path: dir, format: "json", now: "2026-09-23T00:00:00.000Z", toolVersion: "0.0.0", plugins });
  return r.findings.map((f) => f.checkId);
}

describe("chant audit and an auditOptIn check (TF040)", () => {
  test("is not reported by default", async () => {
    expect(await ids(project())).not.toContain("TF040");
  });

  test("is reported when lint.rules enables it", async () => {
    expect(await ids(project({ lint: { rules: { TF040: "warning" } } }))).toContain("TF040");
  });

  test("is not reported when lint.rules sets it off", async () => {
    expect(await ids(project({ lint: { rules: { TF040: "off" } } }))).not.toContain("TF040");
  });
});

describe("readEnabledRules", () => {
  test("lists ids not set to off, and tolerates no config", () => {
    expect([...readEnabledRules(project({ lint: { rules: { A: "error", B: "off", C: ["warning", {}] } } }))].sort()).toEqual(["A", "C"]);
    expect(readEnabledRules(project()).size).toBe(0);
  });
});
