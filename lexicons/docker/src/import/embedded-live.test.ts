/**
 * A `DockerOtelCollector`'s config through `chant import` (#3373, #4388): the
 * config's `content` is handed to the otel importer, and a live import
 * (`chant import --from`, against a fake Engine API) gives the same otel
 * source a file import of the build's `docker-compose.yml` gives, and both
 * give what `chant import config.yaml` gives for the config itself.
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
import { dockerPlugin } from "../plugin";
import { dockerSerializer } from "../serializer";
import { exportResources } from "../export-resources";
import type { DockerEngine } from "./engine";
import { DockerParser } from "./parser";
import { tarOf } from "./testdata/tar";

type Json = Record<string, unknown>;

const pkgDir = resolve(import.meta.dirname, "../..");

const SOURCE = `import { DockerOtelCollector } from "@intentius/chant-lexicon-docker";
import { OtlpHttpExporter } from "@intentius/chant-lexicon-otel";

export const otel = DockerOtelCollector({
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
  writeFileSync(join(dir, "package.json"), '{ "name": "docker-embedded", "private": true, "type": "module" }\n');
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["docker", "otel"] };\n');
  const srcDir = join(dir, "src");
  mkdirSync(srcDir);
  return { dir, srcDir };
}

function files(srcDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  walk(srcDir, srcDir, out);
  return out;
}

function composeOf(out: unknown): string {
  if (typeof out === "string") return out;
  const o = out as { primary?: string; files?: Record<string, string> };
  if (typeof o.primary === "string") return o.primary;
  const yml = Object.entries(o.files ?? {}).find(([p]) => /compose/.test(p));
  if (!yml) throw new Error("no compose file in the build");
  return yml[1];
}

/** The build's compose document for `source`. */
async function compose(source: string): Promise<{ text: string; doc: Json }> {
  const { dir, srcDir } = project();
  try {
    writeFileSync(join(srcDir, "main.ts"), source);
    const result = await build(srcDir, [dockerSerializer, otelSerializer]);
    expect(result.errors).toEqual([]);
    const text = composeOf(result.outputs.get("docker"));
    return { text, doc: load(text) as Json };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The collector's service key and its config text. */
function collector(doc: Json): { service: string; config: string } {
  const services = doc.services as Record<string, Json>;
  const [service, svc] = Object.entries(services).find(([, s]) => Array.isArray(s.configs))!;
  const source = (svc.configs as Json[])[0]!.source as string;
  return { service, config: (doc.configs as Record<string, Json>)[source]!.content as string };
}

/** `chant import config.yaml`: the otel modules for the config alone. */
function standalone(text: string): Record<string, string> {
  return Object.fromEntries(new OtelCollectorGenerator().generate(new OtelCollectorParser().parse(text)).map((f) => [f.path, f.content]));
}

/** The modules under `dir/`, keyed by their path inside it. */
function under(all: Record<string, string>, dir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(all).filter(([p]) => p.startsWith(`${dir}/`)).map(([p, c]) => [p.slice(dir.length + 1), c]));
}

/**
 * A fake Engine holding the collector's container as compose creates it: the
 * service's command, ports and restart policy, compose's labels, and the
 * config's content in the container at its target.
 */
function engine(project: string, service: string, svc: Json, configText: string): DockerEngine {
  const target = ((svc.configs as Json[])[0]!.target as string) ?? COLLECTOR_CONFIG_PATH;
  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const p of (svc.ports as string[]) ?? []) {
    const [host, rest] = p.split(":");
    const [port, proto] = rest!.split("/");
    portBindings[`${port}/${proto ?? "tcp"}`] = [{ HostIp: "", HostPort: host! }];
  }
  const labels = {
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
    "com.docker.compose.container-number": "1",
    "com.docker.compose.oneoff": "False",
    "com.docker.compose.config-hash": "abc",
  };
  const inspect = {
    Id: "c1",
    Name: `/${project}-${service}-1`,
    Config: {
      Image: svc.image,
      Cmd: svc.command,
      Entrypoint: ["/otelcol-contrib"],
      Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
      Labels: { ...labels, "org.opencontainers.image.title": "otelcol-contrib" },
      WorkingDir: "",
      User: "10001",
    },
    HostConfig: { PortBindings: portBindings, RestartPolicy: { Name: svc.restart, MaximumRetryCount: 0 } },
    Mounts: [],
    NetworkSettings: { Networks: { [`${project}_default`]: {} } },
  };
  const image = {
    Config: {
      Cmd: ["--config", "/etc/otelcol-contrib/config.yaml"],
      Entrypoint: ["/otelcol-contrib"],
      Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
      Labels: { "org.opencontainers.image.title": "otelcol-contrib" },
      User: "10001",
    },
  };
  const ok = (body: unknown) => ({ status: 200, body: Buffer.from(JSON.stringify(body)) });
  return async (path) => {
    const url = new URL(`http://docker${path}`);
    if (url.pathname === "/containers/json") {
      const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as { label?: string[] };
      expect(filters.label).toEqual([`com.docker.compose.project=${project}`]);
      return ok([{ Id: "c1", Labels: labels }]);
    }
    if (url.pathname === "/containers/c1/json") return ok(inspect);
    if (url.pathname.startsWith("/images/")) return ok(image);
    if (url.pathname === "/containers/c1/archive") {
      if (url.searchParams.get("path") !== target) return { status: 404, body: Buffer.from('{"message":"not found"}') };
      return { status: 200, body: tarOf([target.split("/").pop()!, configText]) };
    }
    return { status: 404, body: Buffer.alloc(0) };
  };
}

describe("DockerOtelCollector through chant import (#3373, #4388)", () => {
  test("a live import gives the otel source a file import gives, and builds back to the same config", async () => {
    const { text: composeText, doc } = await compose(SOURCE);
    const { service, config } = collector(doc);
    const expected = standalone(config);
    expect(Object.keys(expected).length).toBeGreaterThan(0);

    const fileProject = project();
    const liveProject = project();
    try {
      // File import of the build's docker-compose.yml.
      const templatePath = join(fileProject.dir, "docker-compose.yml");
      writeFileSync(templatePath, composeText);
      const fileResult = await importCommand({ templatePath, output: fileProject.srcDir, lexicon: "docker" });
      expect(fileResult.error).toBeUndefined();
      expect(fileResult.warnings.filter((w) => w.includes("kept as written"))).toEqual([]);
      const fromFile = files(fileProject.srcDir);

      // Live import from a fake Engine.
      const svc = (doc.services as Record<string, Json>)[service]!;
      const plugin: LexiconPlugin = { ...dockerPlugin, exportResources: (options) => exportResources(options, engine("test", service, svc, config)) };
      const liveResult = await liveImportFromPlugins([plugin, otelPlugin], {
        environment: "test",
        output: liveProject.srcDir,
        lexicon: "docker",
        force: true,
      });
      expect(liveResult.error).toBeUndefined();
      expect(liveResult.success).toBe(true);
      expect(liveResult.warnings.filter((w) => w.includes("kept as written"))).toEqual([]);
      const fromLive = files(liveProject.srcDir);

      const dir = service.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      expect(under(fromLive, dir)).toEqual(expected);
      expect(under(fromFile, dir)).toEqual(expected);
      expect(fromLive["main.ts"]).toContain('import { collectorYaml } from "@intentius/chant-lexicon-otel";');
      expect(fromLive["main.ts"]).toContain("content: collectorYaml(");

      // The imported source builds back to the same service and config.
      const result = await build(liveProject.srcDir, [dockerSerializer, otelSerializer]);
      expect(result.errors).toEqual([]);
      const rebuilt = { doc: load(composeOf(result.outputs.get("docker"))) as Json };
      const after = collector(rebuilt.doc);
      expect(load(after.config)).toEqual(load(config));
      const before = (doc.services as Record<string, Json>)[service]!;
      const back = (rebuilt.doc.services as Record<string, Json>)[after.service]!;
      expect(back.image).toBe(before.image);
      expect(back.command).toEqual(before.command);
      expect(back.ports).toEqual(before.ports);
      expect(back.restart).toBe(before.restart);
      expect((back.configs as Json[])[0]!.target).toBe(COLLECTOR_CONFIG_PATH);
    } finally {
      rmSync(fileProject.dir, { recursive: true, force: true });
      rmSync(liveProject.dir, { recursive: true, force: true });
    }
  });

  test("without a context the export keeps the content as read, and offers a reparse", async () => {
    const { doc } = await compose(SOURCE);
    const { service, config } = collector(doc);
    const svc = (doc.services as Record<string, Json>)[service]!;
    const ir = await exportResources({ environment: "test" }, engine("test", service, svc, config));
    const cfg = ir.resources.find((r) => r.type === "config")!;
    expect(cfg.properties.content).toBe(config);
    expect(typeof ir.reparse).toBe("function");
  });

  test("only a config's content that is a document is offered", () => {
    const probe = new EmbeddedImports([], { quiet: true });
    const compose = [
      "services:",
      "  app:",
      "    image: x",
      "    configs: [{ source: motd, target: /etc/motd }, { source: settings, target: /etc/app.yaml }, { source: fromfile }]",
      "configs:",
      "  motd: { content: \"hello there\" }",
      "  settings: { content: \"a: 1\\n\" }",
      "  fromfile: { file: ./x.yaml }",
    ].join("\n");
    new DockerParser().parse(compose, { embedded: probe });
    expect(probe.offered.map((c) => [c.location, c.directory])).toEqual([["config settings content", "app"]]);
  });
});
