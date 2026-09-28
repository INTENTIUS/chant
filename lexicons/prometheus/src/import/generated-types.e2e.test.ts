/**
 * The generated source type-checks against the lexicon's types. Compiling
 * the generated projects takes longer than the unit-test budget allows, so
 * this runs with the e2e tests.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { PrometheusParser } from "./parser";
import { PrometheusGenerator } from "./generator";
import { exampleOutputs, pkgDir, read, repoRoot, sloOutputs, UPSTREAM } from "./testdata/fixtures";

type Files = Array<{ path: string; content: string }>;

/** Type errors in generated projects, compiled together against the lexicon's source with the repo's compiler options. */
function typeErrors(projects: Record<string, Files>): string[] {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  try {
    const files: string[] = [];
    for (const [name, generated] of Object.entries(projects)) {
      const sub = join(dir, name.replace(/[^A-Za-z0-9]+/g, "-"));
      mkdirSync(sub);
      for (const f of generated) {
        writeFileSync(join(sub, f.path), f.content);
        files.push(join(sub, f.path));
      }
    }
    const configFile = ts.readConfigFile(join(repoRoot, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
    const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
    const real = (f: string) => ts.sys.realpath?.(f) ?? f;
    const fileSet = new Set(files.map(real));
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file && fileSet.has(real(d.file.fileName)));
    // A program that saw none of the files would pass vacuously.
    expect(files.every((f) => program.getSourceFile(f) !== undefined)).toBe(true);
    return diagnostics.map((d) => {
      const at = real(d.file!.fileName).slice(real(dir).length + 1);
      return `${at}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const generate = (yaml: string): Files => new PrometheusGenerator().generate(new PrometheusParser().parse(yaml));

describe("the generated source type-checks against the lexicon's types", () => {
  test("for every fixture", async () => {
    const projects: Record<string, Files> = {
      rulesFull: generate(read("rules-full.yml")),
      alertmanagerFull: generate(read("alertmanager-full.yml")),
      ...Object.fromEntries(UPSTREAM.map((f) => [f, generate(read("upstream", f))])),
      ...Object.fromEntries(sloOutputs().map((o) => [o.name, generate(o.yaml)])),
      ...Object.fromEntries((await exampleOutputs()).map((o) => [o.name, generate(o.yaml)])),
    };
    expect(typeErrors(projects)).toEqual([]);
  }, 120_000);

  test("a field outside a notifier's typed config is carried as found, and tsc points at it", () => {
    const yaml = [
      "route:",
      "  receiver: chat",
      "receivers:",
      "  - name: chat",
      "    slack_configs:",
      "      - channel: '#alerts'",
      "        api_url_file: /etc/alertmanager/slack-url",
      "        message_text: '{{ .CommonLabels.alertname }}'",
      "",
    ].join("\n");
    const errors = typeErrors({ slack: generate(yaml) });
    expect(errors).toEqual([expect.stringMatching(/^slack\/receivers\.ts: .*'message_text' does not exist in type 'SlackConfig'/)]);
  }, 120_000);
});
