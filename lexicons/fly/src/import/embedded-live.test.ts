/**
 * A `FlyOtelCollector`'s config through `chant import` (#3373): the machine
 * file at `COLLECTOR_CONFIG_PATH` is handed to the otel importer, and a live
 * import (`chant import --from`) gives the same otel source a file import of
 * the build's `fly.json` gives, and both give what `chant import config.yaml`
 * gives for the config itself.
 */

import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";
import { load } from "js-yaml";
import { importCommand, liveImportFromPlugins } from "@intentius/chant/cli/commands/import";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { build } from "@intentius/chant/build";
import { EmbeddedImports } from "@intentius/chant/import/embedded";
import { COLLECTOR_CONFIG_PATH, otelPlugin, otelSerializer } from "@intentius/chant-lexicon-otel";
import { OtelCollectorParser } from "@intentius/chant-lexicon-otel/import/parser";
import { OtelCollectorGenerator } from "@intentius/chant-lexicon-otel/import/generator";
import { flyPlugin } from "../plugin";
import { flySerializer } from "../serializer";
import { exportResources } from "../export-resources";
import type { FlyHttp } from "../op/activities/fly-apply";
import { FlyParser } from "./parser";
import { decodeRawValue } from "./embedded";

type Json = Record<string, unknown>;

const pkgDir = resolve(import.meta.dirname, "../..");

const SOURCE = `import { App, FlyOtelCollector } from "@intentius/chant-lexicon-fly";
import { OtlpHttpExporter } from "@intentius/chant-lexicon-otel";

export const app = new App({ name: "otel" });
export const collector = FlyOtelCollector({
  region: "iad",
  exporters: [new OtlpHttpExporter({ endpoint: "https://otlp.example.com" })],
});
`;

function walk(dir: string, root: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, root, out);
    else out[relative(root, path)] = readFileSync(path, "utf-8");
  }
}

function project(): { dir: string; srcDir: string } {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  writeFileSync(join(dir, "package.json"), '{ "name": "fly-embedded", "private": true, "type": "module" }\n');
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["fly", "otel"] };\n');
  const srcDir = join(dir, "src");
  mkdirSync(srcDir);
  return { dir, srcDir };
}

function files(srcDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  walk(srcDir, srcDir, out);
  return out;
}

/** The build's flaps plan for a FlyOtelCollector. */
async function plan(): Promise<Record<string, { endpoint: string; body: Json }>> {
  const { dir, srcDir } = project();
  try {
    writeFileSync(join(srcDir, "main.ts"), SOURCE);
    const result = await build(srcDir, [flySerializer, otelSerializer]);
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("fly");
    return JSON.parse(typeof out === "string" ? out : (out as { primary: string }).primary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function machineBody(p: Awaited<ReturnType<typeof plan>>): Json {
  const req = Object.values(p).find((r) => /\/machines\/?$/.test(r.endpoint));
  if (!req) throw new Error("no machine in the plan");
  return req.body;
}

function configText(machine: Json): string {
  const files = (machine.config as Json).files as Json[];
  const file = files.find((f) => f.guest_path === COLLECTOR_CONFIG_PATH)!;
  return decodeRawValue(file.raw_value as string)!;
}

/** `chant import config.yaml`: the otel modules for the config alone. */
function standalone(text: string): Record<string, string> {
  return Object.fromEntries(new OtelCollectorGenerator().generate(new OtelCollectorParser().parse(text)).map((f) => [f.path, f.content]));
}

/** The modules under `dir/`, keyed by their path inside it. */
function under(all: Record<string, string>, dir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(all).filter(([p]) => p.startsWith(`${dir}/`)).map(([p, c]) => [p.slice(dir.length + 1), c]));
}

/** A fake flaps API holding one app and the plan's machine, with the fields a server adds. */
function flaps(machine: Json): FlyHttp {
  const live = { ...machine, id: "m-1", state: "started", instance_id: "I1", private_ip: "fdaa::1" };
  return async (_method, url) => {
    if (/\/v1\/apps\/otel\/machines/.test(url)) return { status: 200, text: JSON.stringify([live]) };
    if (/\/v1\/apps\/otel$/.test(url)) return { status: 200, text: JSON.stringify({ name: "otel", organization: { slug: "acme" } }) };
    return { status: 404, text: "" };
  };
}

describe("FlyOtelCollector through chant import (#3373)", () => {
  test("a live import gives the otel source a file import gives, and builds back to the same config", async () => {
    const p = await plan();
    const machine = machineBody(p);
    const text = configText(machine);
    const name = machine.name as string;
    const expected = standalone(text);
    expect(Object.keys(expected).length).toBeGreaterThan(0);

    // File import of the build's fly.json.
    const fileProject = project();
    // Live import from a fake flaps API.
    const liveProject = project();
    const prevApp = process.env.FLY_APP_NAME;
    process.env.FLY_APP_NAME = "otel";
    try {
      const templatePath = join(fileProject.dir, "fly.json");
      writeFileSync(templatePath, JSON.stringify(p));
      const fileResult = await importCommand({ templatePath, output: fileProject.srcDir, lexicon: "fly" });
      expect(fileResult.error).toBeUndefined();
      expect(fileResult.warnings.filter((w) => w.includes("kept as written"))).toEqual([]);
      const fromFile = files(fileProject.srcDir);

      const plugin: LexiconPlugin = { ...flyPlugin, exportResources: (options) => exportResources(options, flaps(machine)) };
      const liveResult = await liveImportFromPlugins([plugin, otelPlugin], {
        environment: "test",
        output: liveProject.srcDir,
        lexicon: "fly",
        force: true,
      });
      expect(liveResult.error).toBeUndefined();
      expect(liveResult.success).toBe(true);
      expect(liveResult.warnings.filter((w) => w.includes("kept as written"))).toEqual([]);
      const fromLive = files(liveProject.srcDir);

      expect(under(fromLive, name)).toEqual(expected);
      expect(under(fromFile, name)).toEqual(expected);
      expect(fromLive["main.ts"]).toContain('import { collectorYaml } from "@intentius/chant-lexicon-otel";');
      expect(fromLive["main.ts"]).toContain("raw_value: Buffer.from(collectorYaml(");

      // The imported source builds back to the config the machine holds.
      const rebuilt = await build(liveProject.srcDir, [flySerializer, otelSerializer]);
      expect(rebuilt.errors).toEqual([]);
      const out = rebuilt.outputs.get("fly");
      const after = machineBody(JSON.parse(typeof out === "string" ? out : (out as { primary: string }).primary));
      expect(load(configText(after))).toEqual(load(text));
    } finally {
      if (prevApp === undefined) delete process.env.FLY_APP_NAME;
      else process.env.FLY_APP_NAME = prevApp;
      rmSync(fileProject.dir, { recursive: true, force: true });
      rmSync(liveProject.dir, { recursive: true, force: true });
    }
  });

  test("without a context the export keeps the file as read, and offers a reparse", async () => {
    const machine = machineBody(await plan());
    const prevApp = process.env.FLY_APP_NAME;
    process.env.FLY_APP_NAME = "otel";
    try {
      const ir = await exportResources({ environment: "test" }, flaps(machine));
      const m = ir.resources.find((r) => r.type === "Fly::Machines::Machine")!;
      const file = ((m.properties.config as Json).files as Json[])[0];
      expect(typeof file.raw_value).toBe("string");
      expect(typeof ir.reparse).toBe("function");
    } finally {
      if (prevApp === undefined) delete process.env.FLY_APP_NAME;
      else process.env.FLY_APP_NAME = prevApp;
    }
  });

  test("a file that is not a document, or not text, is never offered", () => {
    const probe = new EmbeddedImports([], { quiet: true });
    const files = [
      { guest_path: "/etc/motd", raw_value: Buffer.from("hello there\n").toString("base64") },
      { guest_path: "/bin/blob", raw_value: Buffer.from([0xff, 0xfe, 0x00, 0x81]).toString("base64") },
      { guest_path: "/etc/app.yaml", raw_value: Buffer.from("a: 1\n").toString("base64") },
    ];
    new FlyParser().parse(JSON.stringify({ name: "m", config: { image: "x", files } }), { embedded: probe });
    expect(probe.offered.map((c) => c.location)).toEqual(["Machine m file /etc/app.yaml"]);
  });
});
