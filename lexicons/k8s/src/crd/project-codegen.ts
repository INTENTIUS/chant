/**
 * Project-local CRD classes: the k8s lexicon's `projectCodegen` hook
 * (`chant generate`, core's project-codegen.ts).
 *
 * A project lists CRD sources under `k8s.crds` in `chant.config.ts`. Generation
 * parses each CRD with the same parser the lexicon's own CRD_SOURCES go
 * through (./parser.ts), so the entity type, GVK and spec field schema match
 * what a shipped CRD gets, and writes two files to `<outDir>/k8s/`:
 *
 * - `index.ts`: a typed class per kind. Its props are typed from the CRD's
 *   `openAPIV3Schema` (a shipped CRD's `.d.ts` types `spec` as a record; a
 *   project's own types it fully). The module registers its kinds with
 *   ../project-kinds.ts when imported.
 * - `kinds.json`: each kind's GVK and spec field schema, which a build loads
 *   (`load`) so the serializer and the WK8501/WK8502 spec checks know the
 *   kinds whatever process imported the module.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAll } from "js-yaml";
import { GENERATED_TS_HEADER, type ProjectCodegen, type ProjectCodegenContext } from "@intentius/chant/project-codegen";
import { jsdocLines, schemaToTypeScript, tsPropertyKey } from "@intentius/chant/codegen/json-schema-to-ts";
import { fetchWithRetry } from "@intentius/chant/codegen/fetch";
import type { K8sProjectCrdSource } from "../config";
import { namespaceSegmentForGroup } from "../group-namespace";
import { registerProjectKinds, type ProjectKind } from "../project-kinds";
import { gvkToApiVersion } from "../spec/parse";
import { fetchCRDContent } from "./loader";
import { crdTargetVersion, parseCRDSpec } from "./parser";
import type { CRDSpec } from "./types";

/** The registry file written beside the module. */
export const KINDS_FILE = "kinds.json";

/** Fields every resource class handles itself; a CRD's own schema for them is ignored. */
const RESERVED_FIELDS = new Set(["apiVersion", "kind", "metadata", "status"]);

/** How `generate` reaches a source's content. Tests replace these. */
export interface CrdSourceReaders {
  /** Fetch a URL source's body. Default: `ctx.fetch`, else core's retrying fetch. */
  fetchUrl?: (url: string) => Promise<string>;
  /** Read a Helm chart's CRDs. Default: the lexicon's CRD loader. */
  readChart?: (source: Extract<K8sProjectCrdSource, { type: "helm" }>) => Promise<string>;
}

/** The hook, with injectable readers. */
export function k8sProjectCodegen(readers: CrdSourceReaders = {}): ProjectCodegen {
  return {
    inputs: (ctx) => {
      const sources = declaredSources(ctx);
      if (!sources) return undefined;
      return sources.map((source, i) => describeSource(source, i, ctx.projectRoot));
    },

    async generate(ctx) {
      const sources = declaredSources(ctx) ?? [];
      const fetchUrl =
        readers.fetchUrl ??
        (async (url: string) => {
          const response = ctx.fetch ? await ctx.fetch(url) : await fetchWithRetry(url);
          if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
          return response.text();
        });
      const readChart =
        readers.readChart ??
        ((s: Extract<K8sProjectCrdSource, { type: "helm" }>) =>
          fetchCRDContent({ type: "helm", chart: s.chart, version: s.version, digest: s.digest, chartSubdir: s.chartSubdir }));

      const kinds: GeneratedKind[] = [];
      for (const [i, source] of sources.entries()) {
        describeSource(source, i, ctx.projectRoot); // validates the pin before any fetch
        let content: string;
        if (source.type === "file") {
          content = readFileSync(resolve(ctx.projectRoot, source.path), "utf8");
        } else if (source.type === "url") {
          content = await fetchUrl(source.url);
          const actual = sha256(content);
          if (actual !== normalizeSha(source.sha256)) {
            throw new Error(
              `k8s.crds[${i}]: ${source.url} has sha256 ${actual}, but the config pins ${normalizeSha(source.sha256)}. ` +
                "Check the URL points at a fixed release, then update the pin.",
            );
          }
        } else {
          content = await readChart(source);
        }
        const found = crdKinds(content, source.kinds);
        if (found.length === 0) {
          throw new Error(`k8s.crds[${i}] (${sourceLabel(source)}) holds no CustomResourceDefinition${source.kinds ? ` of kind ${source.kinds.join(", ")}` : ""}`);
        }
        kinds.push(...found);
      }

      assignClassNames(kinds);
      return {
        files: { "index.ts": renderModule(kinds), [KINDS_FILE]: renderKinds(kinds) },
        summary: kinds.map((k) => `${k.className} (${k.apiVersion}, ${k.scope === "Cluster" ? "cluster-scoped" : "namespaced"})`),
      };
    },

    load(ctx) {
      const path = join(ctx.outDir, KINDS_FILE);
      if (!existsSync(path)) return;
      registerProjectKinds(JSON.parse(readFileSync(path, "utf8")) as ProjectKind[]);
    },
  };
}

function declaredSources(ctx: ProjectCodegenContext): K8sProjectCrdSource[] | undefined {
  const k8s = ctx.config.k8s as { crds?: K8sProjectCrdSource[] } | undefined;
  return k8s?.crds && k8s.crds.length > 0 ? k8s.crds : undefined;
}

/**
 * A source as a JSON value for the drift digest: a file by the hash of its
 * content, a remote source by its pin. Throws on an unpinned remote source
 * or a missing file.
 */
function describeSource(source: K8sProjectCrdSource, i: number, projectRoot: string): Record<string, unknown> {
  const kinds = source.kinds ? { kinds: [...source.kinds].sort() } : {};
  switch (source.type) {
    case "file": {
      const path = resolve(projectRoot, source.path);
      if (!existsSync(path)) throw new Error(`k8s.crds[${i}]: CRD file not found: ${source.path}`);
      return { type: "file", path: source.path, sha256: sha256(readFileSync(path)), ...kinds };
    }
    case "url":
      if (typeof source.sha256 !== "string" || !/^(sha256:)?[0-9a-f]{64}$/.test(source.sha256)) {
        throw new Error(
          `k8s.crds[${i}]: ${source.url} needs a sha256 pin of its content. An unpinned URL makes the generated classes depend on when they were generated.`,
        );
      }
      return { type: "url", url: source.url, sha256: normalizeSha(source.sha256), ...kinds };
    case "helm":
      if (!source.version) {
        throw new Error(`k8s.crds[${i}]: chart ${source.chart} needs a version. An unpinned chart makes the generated classes depend on when they were generated.`);
      }
      return {
        type: "helm",
        chart: source.chart,
        version: source.version,
        ...(source.digest ? { digest: source.digest } : {}),
        ...(source.chartSubdir ? { chartSubdir: source.chartSubdir } : {}),
        ...kinds,
      };
    default:
      throw new Error(`k8s.crds[${i}]: unsupported source type ${JSON.stringify((source as { type?: unknown }).type)}`);
  }
}

function sourceLabel(source: K8sProjectCrdSource): string {
  return source.type === "file" ? source.path : source.type === "url" ? source.url : `${source.chart} ${source.version}`;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeSha(pin: string): string {
  return pin.replace(/^sha256:/, "");
}

interface GeneratedKind {
  resourceType: string;
  apiVersion: string;
  kind: string;
  group: string;
  scope: "Namespaced" | "Cluster";
  attributes: Array<{ name: string; tsType: string }>;
  specSchema?: ProjectKind["specSchema"];
  schema?: Record<string, unknown>;
  className: string;
}

/** Every CRD in a (multi-document) YAML text, filtered to `allow` when given. */
function crdKinds(content: string, allow: string[] | undefined): GeneratedKind[] {
  const docs: unknown[] = [];
  loadAll(content, (doc) => docs.push(doc));
  const out: GeneratedKind[] = [];
  for (const doc of docs) {
    if (!doc || typeof doc !== "object") continue;
    const d = doc as { kind?: unknown; spec?: CRDSpec };
    if (d.kind !== "CustomResourceDefinition" || !d.spec?.group || !d.spec.names?.kind || !d.spec.versions) continue;
    if (allow && allow.length > 0 && !allow.includes(d.spec.names.kind)) continue;
    const [parsed] = parseCRDSpec(d.spec);
    const version = crdTargetVersion(d.spec);
    if (!parsed || !version) continue;
    out.push({
      resourceType: parsed.resource.typeName,
      apiVersion: gvkToApiVersion(parsed.gvk),
      kind: parsed.gvk.kind,
      group: d.spec.group,
      scope: d.spec.scope ?? "Namespaced",
      attributes: parsed.resource.attributes,
      ...(parsed.specSchema ? { specSchema: parsed.specSchema } : {}),
      schema: version.schema?.openAPIV3Schema as Record<string, unknown> | undefined,
      className: parsed.gvk.kind,
    });
  }
  return out;
}

/**
 * Class names are the kind. Two kinds of the same name from different groups
 * both take the group's namespace segment as a prefix (`CertManagerCertificate`);
 * the same group and kind twice is an error.
 */
function assignClassNames(kinds: GeneratedKind[]): void {
  const seen = new Set<string>();
  for (const k of kinds) {
    const key = `${k.group}/${k.kind}`;
    if (seen.has(key)) throw new Error(`k8s.crds declares ${k.kind} (${k.group}) more than once`);
    seen.add(key);
  }
  const byKind = new Map<string, GeneratedKind[]>();
  for (const k of kinds) byKind.set(k.kind, [...(byKind.get(k.kind) ?? []), k]);
  for (const group of byKind.values()) {
    if (group.length < 2) continue;
    for (const k of group) k.className = `${namespaceSegmentForGroup(k.group).replace(/[^A-Za-z0-9]/g, "")}${k.kind}`;
  }
  kinds.sort((a, b) => a.className.localeCompare(b.className));
}

function renderKinds(kinds: GeneratedKind[]): string {
  const entries: ProjectKind[] = kinds.map((k) => ({
    resourceType: k.resourceType,
    apiVersion: k.apiVersion,
    kind: k.kind,
    ...(k.specSchema ? { specSchema: k.specSchema } : {}),
  }));
  return JSON.stringify(entries, null, 2) + "\n";
}

/**
 * The metadata a manifest author sets. Declared in the module rather than
 * imported: the lexicon's `ObjectMeta` export is a runtime constructor, and
 * its typed declaration is not reachable from every install.
 */
const OBJECT_META = [
  "/** Standard object metadata: the fields a manifest sets. */",
  "export interface ObjectMeta {",
  "  name?: string;",
  "  generateName?: string;",
  "  namespace?: string;",
  "  labels?: Record<string, string>;",
  "  annotations?: Record<string, string>;",
  "  finalizers?: string[];",
  "  ownerReferences?: Array<{",
  "    apiVersion: string;",
  "    kind: string;",
  "    name: string;",
  "    uid: string;",
  "    controller?: boolean;",
  "    blockOwnerDeletion?: boolean;",
  "  }>;",
  "}",
];

function renderModule(kinds: GeneratedKind[]): string {
  const lines: string[] = [
    GENERATED_TS_HEADER,
    "// Classes for the custom resources k8s.crds declares in chant.config.",
    'import type { Declarable } from "@intentius/chant";',
    'import { createResource } from "@intentius/chant/runtime";',
    'import { registerProjectKinds } from "@intentius/chant-lexicon-k8s";',
    "",
    "registerProjectKinds([",
    ...kinds.map((k) => `  ${JSON.stringify({ resourceType: k.resourceType, apiVersion: k.apiVersion, kind: k.kind })},`),
    "]);",
    "",
    ...OBJECT_META,
  ];

  for (const k of kinds) {
    const name = k.className;
    const properties = (k.schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((k.schema?.required as string[] | undefined) ?? []);
    const fields = Object.keys(properties).filter((f) => !RESERVED_FIELDS.has(f));

    const members: string[] = ["  /** Standard object's metadata. */", "  metadata?: ObjectMeta;"];
    for (const field of fields) {
      const typeName = `${name}${pascal(field)}`;
      const { type, declarations } = schemaToTypeScript(properties[field], {
        openByDefault: false,
        namePrefix: typeName,
      });
      for (const d of declarations) {
        lines.push("", ...jsdocLines(d.description, ""), `export type ${d.name} = ${d.type};`);
      }
      lines.push(
        "",
        `/** The \`${field}\` of a ${k.kind} (${k.apiVersion}). */`,
        `export type ${typeName} = ${type};`,
      );
      members.push(...jsdocLines(properties[field].description, "  "));
      members.push(`  ${tsPropertyKey(field)}${required.has(field) ? "" : "?"}: ${typeName};`);
    }

    const attrMap = Object.fromEntries(k.attributes.map((a) => [a.name, a.name]));
    lines.push(
      "",
      `/** Props for a ${k.kind}, a custom resource of ${k.apiVersion}. */`,
      `export interface ${name}Props {`,
      ...members,
      "}",
      "",
      `/** A ${k.kind} (${k.apiVersion}, ${k.scope === "Cluster" ? "cluster-scoped" : "namespaced"}). */`,
      `export interface ${name} extends Declarable {`,
      ...k.attributes.map((a) => `  readonly ${a.name}: ${a.tsType};`),
      "}",
      "",
      `export const ${name}: new (props: ${name}Props) => ${name} = createResource(${JSON.stringify(k.resourceType)}, "k8s", ${JSON.stringify(attrMap)}) as never;`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}
