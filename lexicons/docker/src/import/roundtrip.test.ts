import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { DockerParser, DockerfileParser } from "./parser";
import { DockerGenerator } from "./generator";
import { DockerTemplateGenerator, DockerTemplateParser } from "./adapter";
import { Dockerfile } from "../generated/index";
import { dockerSerializer } from "../serializer";
import type { Declarable } from "@intentius/chant/declarable";
import { parseYAML } from "@intentius/chant/yaml";
import * as lexicon from "../index";

/**
 * Dockerfile -> TypeScript -> Dockerfile. The generated source is run (its
 * import line dropped, its exports collected) and the entity it declares is
 * serialized again.
 */
function roundTrip(content: string, source?: string): { source: string; dockerfile: string } {
  const src = source ?? new DockerGenerator().generate([new DockerfileParser().parse("app", content)]).source;
  const body = src.replace(/^import .*$/m, "").replace(/export const (\w+) =/g, "out.$1 =");
  const out: Record<string, Declarable> = {};
  new Function("Dockerfile", "out", body)(Dockerfile, out);
  const result = dockerSerializer.serialize(new Map(Object.entries(out))) as { files: Record<string, string> };
  return { source: src, dockerfile: Object.values(result.files)[0]! };
}

const testdata = (file: string) =>
  readFileSync(join(import.meta.dirname, "testdata", file), "utf8");

describe("roundtrip: parse → generate", () => {
  test("simple.yaml → Service + Volume constructors", () => {
    const { entities } = new DockerParser().parse(testdata("simple.yaml"));
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("new Service(");
    expect(source).toContain("new Volume(");
    expect(source).toContain("nginx:1.25");
  });

  test("webapp.yaml → ports / healthcheck / depends_on survive roundtrip", () => {
    const { entities } = new DockerParser().parse(testdata("webapp.yaml"));
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("3000:3000");
    expect(source).toContain("depends_on");
    expect(source).toContain("healthcheck");
    expect(source).toContain("unless-stopped");
  });

  test("full.yaml → Config / Secret / Network constructors present", () => {
    const { entities } = new DockerParser().parse(testdata("full.yaml"));
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("new DockerConfig(");
    expect(source).toContain("new DockerSecret(");
    expect(source).toContain("new Network(");
  });

  test("multi-stage Dockerfile inline → stages: in output", () => {
    const content = [
      "FROM node:20-alpine AS builder",
      "RUN npm ci",
      "FROM nginx:1.25 AS runner",
      "COPY --from=builder /app/dist /usr/share/nginx/html",
    ].join("\n");
    const entity = new DockerfileParser().parse("app", content);
    const { source } = new DockerGenerator().generate([entity]);
    expect(source).toContain("stages");
    expect(source).toContain("node:20-alpine");
    expect(source).toContain("nginx:1.25");
  });

});

describe("roundtrip: Dockerfile → TypeScript → Dockerfile keeps the instruction order", () => {
  test("interleaved COPY and RUN", () => {
    const content = [
      "FROM node:20-alpine",
      "WORKDIR /app",
      "COPY package*.json ./",
      "RUN npm ci",
      "COPY . .",
      "RUN npm run build",
      'CMD ["node", "dist/index.js"]',
      "",
    ].join("\n");
    const { source, dockerfile } = roundTrip(content);
    expect(source).toContain("steps: [");
    expect(dockerfile).toBe(content);
  });

  test("USER after RUN stays after it", () => {
    const content = [
      "FROM debian:12-slim",
      "RUN apt-get update && apt-get install -y --no-install-recommends curl",
      "RUN useradd --system app",
      "USER app",
      "RUN whoami",
      "",
    ].join("\n");
    expect(roundTrip(content).dockerfile).toBe(content);
  });

  test("multi-stage, ARG before FROM, SHELL, STOPSIGNAL, ONBUILD and repeated WORKDIR", () => {
    const content = [
      "ARG NODE_VERSION=20",
      "FROM node:${NODE_VERSION}-alpine AS build",
      'SHELL ["/bin/sh", "-c"]',
      "WORKDIR /src",
      "COPY . .",
      "WORKDIR /src/app",
      "RUN npm run build",
      "FROM nginx:1.27-alpine",
      "COPY --from=build /src/app/dist /usr/share/nginx/html",
      "ONBUILD COPY . /usr/share/nginx/html",
      "STOPSIGNAL SIGQUIT",
      "",
    ].join("\n");
    const { source, dockerfile } = roundTrip(content);
    expect(source).toContain('globalArgs: ["NODE_VERSION=20"]');
    expect(dockerfile).toBe(content);
  });

  test("line continuations and heredocs are kept as written", () => {
    const content = [
      "# syntax=docker/dockerfile:1",
      "FROM debian:12-slim",
      "RUN apt-get update \\",
      "    # a comment Docker drops",
      "    && apt-get install -y --no-install-recommends curl",
      "RUN <<EOF",
      "set -e",
      "echo hello > /hello",
      "EOF",
      "USER nobody",
      "",
    ].join("\n");
    const { dockerfile } = roundTrip(content);
    expect(dockerfile).toBe([
      "FROM debian:12-slim",
      "RUN apt-get update \\",
      "    && apt-get install -y --no-install-recommends curl",
      "RUN <<EOF",
      "set -e",
      "echo hello > /hello",
      "EOF",
      "USER nobody",
      "",
    ].join("\n"));
  });

  test("chant import of a Dockerfile goes through the template adapter", () => {
    const content = "FROM alpine:3.20\nCOPY run.sh /run.sh\nRUN chmod +x /run.sh\nUSER nobody\n";
    const ir = new DockerTemplateParser().parse(content);
    const [file] = new DockerTemplateGenerator().generate(ir);
    expect(file!.content).toContain("export const app = new Dockerfile({");
    expect(roundTrip(content, file!.content).dockerfile).toBe(content);
  });
});

/** The names the generated source imports from the lexicon package. */
function importedNames(source: string): string[] {
  const m = source.match(/^import \{ ([^}]+) \} from "@intentius\/chant-lexicon-docker";$/m);
  return m ? m[1]!.split(",").map((n) => n.trim()) : [];
}

/**
 * Run imported source against the lexicon package and serialize what it
 * exports. Each name on its import line is bound from the package's real
 * exports, so a name the package lacks fails here (#3933).
 */
function buildImport(source: string): string {
  const names = importedNames(source);
  const body = source.replace(/^import .*$/m, "").replace(/export const (\w+) =/g, "out.$1 =");
  const out: Record<string, Declarable> = {};
  const exports = lexicon as Record<string, unknown>;
  new Function(...names, "out", body)(...names.map((n) => exports[n]), out);
  const result = dockerSerializer.serialize(new Map(Object.entries(out)));
  return typeof result === "string" ? result : result.primary ?? "";
}

describe("roundtrip: compose → TypeScript → compose", () => {
  test("configs and secrets import as DockerConfig and DockerSecret and build the same file", () => {
    const content = testdata("configs-secrets.yaml");
    const { entities } = new DockerParser().parse(content);
    const { source } = new DockerGenerator().generate(entities);
    expect(importedNames(source)).toEqual(["DockerConfig", "DockerSecret", "Service"]);
    expect(source).toContain("new DockerConfig(");
    expect(source).toContain("new DockerSecret(");
    expect(parseYAML(buildImport(source))).toEqual(parseYAML(content));
  });

  test("full.yaml builds the same file: every field kept, hyphenated keys kept (#3937)", () => {
    const content = testdata("full.yaml");
    const { entities, warnings } = new DockerParser().parse(content);
    expect(warnings).toEqual([]);
    const { source } = new DockerGenerator().generate(entities);
    expect(parseYAML(buildImport(source))).toEqual(parseYAML(content));
  });

  test("fields outside the old fixed list, x- extensions, and keys that are not identifiers survive (#3937)", () => {
    const content = testdata("names-and-fields.yaml");
    const { entities, warnings } = new DockerParser().parse(content);
    expect(warnings).toEqual([]);
    const { source } = new DockerGenerator().generate(entities);
    expect(parseYAML(buildImport(source))).toEqual(parseYAML(content));
  });

  test("through the chant import adapter", () => {
    const content = testdata("names-and-fields.yaml");
    const [file] = new DockerTemplateGenerator().generate(new DockerTemplateParser().parse(content));
    expect(parseYAML(buildImport(file!.content))).toEqual(parseYAML(content));
  });
});

describe("compose import warns on what it cannot keep (#3937)", () => {
  test("a field the Compose spec does not define is dropped with a warning", () => {
    const content = "services:\n  api:\n    image: nginx\n    not_a_field: 1\nnetworks:\n  n:\n    bogus: true\n";
    const { entities, warnings } = new DockerParser().parse(content);
    expect(entities.find((e) => e.name === "api")).toMatchObject({ props: { image: "nginx" } });
    expect(warnings).toEqual([
      'services.api: "not_a_field" is not a Compose service field and was dropped',
      'networks.n: "bogus" is not a Compose network field and was dropped',
    ]);
  });

  test("a top-level section import does not carry is named", () => {
    const { warnings } = new DockerParser().parse("name: proj\nservices:\n  a:\n    image: x\n");
    expect(warnings).toEqual(['"name" at the top level is not imported']);
  });

  test("the adapter hands parser warnings to chant import", () => {
    const ir = new DockerTemplateParser().parse("services:\n  api:\n    image: nginx\n    not_a_field: 1\n");
    expect(ir.warnings).toEqual(['services.api: "not_a_field" is not a Compose service field and was dropped']);
  });
});

describe("every name the importers emit is exported by the lexicon", () => {
  test("compose and Dockerfile imports name only exported constructors", () => {
    const entities = [
      ...new DockerParser().parse(testdata("full.yaml")).entities,
      new DockerfileParser().parse("app", "FROM alpine:3.20\nRUN true\n"),
    ];
    expect(new Set(entities.map((e) => e.kind))).toEqual(new Set(["service", "volume", "network", "config", "secret", "dockerfile"]));
    const names = importedNames(new DockerGenerator().generate(entities).source);
    // The six constructors, and composeKey for full.yaml's hyphenated keys.
    expect(names.length).toBe(7);
    for (const name of names) {
      expect(typeof (lexicon as Record<string, unknown>)[name], name).toBe("function");
    }
    // Through the `chant import` adapter too.
    for (const content of [testdata("full.yaml"), "FROM alpine:3.20\nRUN true\n"]) {
      for (const file of new DockerTemplateGenerator().generate(new DockerTemplateParser().parse(content))) {
        for (const name of importedNames(file.content)) {
          expect(typeof (lexicon as Record<string, unknown>)[name], `${file.path}: ${name}`).toBe("function");
        }
      }
    }
  });
});
