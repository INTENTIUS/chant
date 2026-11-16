#!/usr/bin/env tsx
/**
 * Writes the two vendored Prow schemas this lexicon generates from and
 * checks against, from sigs.k8s.io/prow at the version tools/go.mod pins
 * (Apache-2.0):
 *
 * - `job-config.schema.json`: the job config Prow loads. Its job-level fields
 *   come from Prow's Go types (`go run ./schema` in tools/, which reads
 *   them by reflection), and the types the ProwJob CRD also carries (the pod
 *   spec, the decoration config, refs, the reporter and rerun configs) come
 *   from the CRD, so the generated types and the CRD agree.
 * - `prowjob-spec.schema.json`: the `spec` of the ProwJob CRD, which the
 *   ProwJobs Prow makes from a job config must satisfy.
 *
 *   npm run vendor          (from lexicons/prow)
 *
 * Both read the module from Go's module cache with GOPROXY=off, so the run
 * downloads nothing: fetch the pinned module once with `go mod download` in
 * tools/ when the cache does not hold it. The CRD is
 * config/prow/cluster/prowjob-crd/ in the module. Each schema drops formats
 * and list-type hints, spells x-kubernetes-int-or-string as integer or
 * string, and closes every object that lists its properties and does not
 * preserve unknown fields: where Prow's strict loader or the API server
 * refuses a field the type does not name, the schema refuses it too.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import { moduleSourceDir } from "@intentius/chant/module-source";

type Node = Record<string, unknown>;

const SPEC_DIR = moduleSourceDir(import.meta.url);
const TOOLS = join(SPEC_DIR, "..", "..", "tools");
const OFFLINE = { ...process.env, GOFLAGS: "-mod=mod", GOPROXY: "off" };

/** The pinned module's version, from tools/go.mod. */
export function prowVersion(goMod = readFileSync(join(TOOLS, "go.mod"), "utf-8")): string {
  const m = /^require sigs\.k8s\.io\/prow (\S+)$/m.exec(goMod);
  if (!m) throw new Error("tools/go.mod requires no sigs.k8s.io/prow");
  return m[1];
}

/**
 * Drop what JSON Schema draft 7 does not read and close listed objects.
 * Descriptions stay `keep` levels of properties deep: 2 keeps a type's own
 * and its fields', which the generated types and docs show.
 */
export function tidy(v: unknown, keep = 0): unknown {
  if (Array.isArray(v)) return v.map((x) => tidy(x));
  if (v === null || typeof v !== "object") return v;
  const n = v as Node;
  const out: Node = {};
  for (const [k, x] of Object.entries(n)) {
    if (k === "description" && keep <= 0) continue;
    if (k === "format" || k === "x-kubernetes-list-type" || k === "x-kubernetes-list-map-keys" || k === "x-kubernetes-map-type") continue;
    if (k === "x-kubernetes-int-or-string" || k === "x-kubernetes-preserve-unknown-fields") continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(x as Node).map(([p, s]) => [p, tidy(s, keep - 1)])) : tidy(x);
  }
  if (n["x-kubernetes-int-or-string"] === true) {
    delete out.type;
    out.anyOf = [{ type: "integer" }, { type: "string" }];
  }
  if (out.type === "object" && out.properties && n["x-kubernetes-preserve-unknown-fields"] !== true && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

interface GoField {
  key: string;
  type: GoType;
  description?: string;
}
type GoType = string | { array: GoType } | { map: GoType } | { ref: string };

/** The CRD's ProwJob spec property that carries each Go type the job config shares with it. */
const FROM_CRD: Record<string, (spec: Node) => unknown> = {
  PodSpec: (s) => s.pod_spec,
  DecorationConfig: (s) => s.decoration_config,
  Refs: (s) => (s.extra_refs as Node).items,
  ReporterConfig: (s) => s.reporter_config,
  RerunAuthConfig: (s) => s.rerun_auth_config,
  ProwJobDefault: (s) => s.prowjob_defaults,
  PipelineRunSpec: (s) => s.pipeline_run_spec,
  TektonPipelineRunSpec: (s) => s.tekton_pipeline_run_spec,
};

/**
 * Parts of the pod spec named as definitions of their own, so the generated
 * types name them (Container, EnvVar, Volume, ...). Each is a path below
 * PodSpec; `[]` steps into an array's items.
 */
const HOISTED: Array<[string, string, string[]]> = [
  ["Container", "PodSpec", ["containers", "[]"]],
  ["EnvVar", "Container", ["env", "[]"]],
  ["EnvFromSource", "Container", ["envFrom", "[]"]],
  ["VolumeMount", "Container", ["volumeMounts", "[]"]],
  ["ResourceRequirements", "Container", ["resources"]],
  ["SecurityContext", "Container", ["securityContext"]],
  ["Volume", "PodSpec", ["volumes", "[]"]],
  ["Toleration", "PodSpec", ["tolerations", "[]"]],
];

function goSchema(t: GoType): Node {
  if (t === "string" || t === "boolean" || t === "integer") return { type: t };
  if (typeof t === "string") return {};
  if ("array" in t) return { type: "array", items: goSchema(t.array) };
  if ("map" in t) return { type: "object", additionalProperties: goSchema(t.map) };
  return { $ref: `#/definitions/${t.ref}` };
}

function at(node: Node, path: string[]): Node {
  let cur = node;
  for (const step of path) cur = (step === "[]" ? cur.items : (cur.properties as Node)[step]) as Node;
  return cur;
}

function setAt(node: Node, path: string[], value: Node): void {
  const parent = at(node, path.slice(0, -1));
  const last = path[path.length - 1];
  if (last === "[]") parent.items = value;
  else (parent.properties as Node)[last] = value;
}

/** Both schemas from the Go types' fields and the CRD, as the text written to disk. */
export function vendorSchemas(input: { kinds: { kinds: { name: string; fields: GoField[] }[]; definitions: Record<string, GoField[]> }; crd: Node; version: string }): { jobConfig: string; prowJobSpec: string } {
  const version = (((input.crd.spec as Node).versions as Node[])[0].schema as Node).openAPIV3Schema as Node;
  const spec = (version.properties as Node).spec as Node;
  const crdProps = spec.properties as Node;
  const source = `sigs.k8s.io/prow ${input.version} (Apache-2.0)`;

  const prowJobSpec = {
    $comment: `ProwJob .spec from ${source}, config/prow/cluster/prowjob-crd, written by lexicons/prow/src/spec/vendor.ts`,
    $schema: "http://json-schema.org/draft-07/schema#",
    ...(tidy(spec) as Node),
  };

  const definitions: Node = {};
  const object = (fields: GoField[], required: string[] = []): Node => ({
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.key, { ...goSchema(f.type), ...(f.description ? { description: f.description } : {}) }])),
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  });
  for (const k of input.kinds.kinds) definitions[k.name] = object(k.fields, ["name"]);
  for (const [name, fields] of Object.entries(input.kinds.definitions)) definitions[name] = object(fields);
  for (const [name, pick] of Object.entries(FROM_CRD)) definitions[name] = tidy(pick(crdProps), 2);
  for (const [name, from, path] of HOISTED) {
    const host = definitions[from] as Node;
    definitions[name] = tidy(raw(crdProps.pod_spec as Node, from, path), 2);
    setAt(host, path, { $ref: `#/definitions/${name}` });
    // An init or ephemeral container has the same shape as a container: name it the same.
    if (name === "Container") {
      const init = tidy(raw(crdProps.pod_spec as Node, "PodSpec", ["initContainers", "[]"]), 2);
      if (JSON.stringify(init) === JSON.stringify(definitions.Container)) setAt(host, ["initContainers", "[]"], { $ref: "#/definitions/Container" });
    }
  }

  const jobs = (kind: string): Node => ({ type: "array", items: { $ref: `#/definitions/${kind}` } });
  const jobConfig = {
    $comment: `The Prow job config from ${source}: job fields from pkg/config's Go types, the shared types from the ProwJob CRD, written by lexicons/prow/src/spec/vendor.ts`,
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      presubmits: { type: "object", additionalProperties: jobs("Presubmit") },
      postsubmits: { type: "object", additionalProperties: jobs("Postsubmit") },
      periodics: jobs("Periodic"),
    },
    additionalProperties: false,
    definitions,
  };
  return { jobConfig: `${JSON.stringify(jobConfig, null, 1)}\n`, prowJobSpec: `${JSON.stringify(prowJobSpec)}\n` };
}

/** The CRD's own node a hoisted path names, before any of it was replaced by a reference. */
function raw(podSpec: Node, from: string, path: string[]): Node {
  const prefix: Record<string, string[]> = { PodSpec: [], Container: ["containers", "[]"] };
  return at(podSpec, [...prefix[from], ...path]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = execFileSync("go", ["list", "-m", "-f", "{{.Dir}}", "sigs.k8s.io/prow"], { cwd: TOOLS, env: OFFLINE, encoding: "utf-8" }).trim();
  const kinds = JSON.parse(execFileSync("go", ["run", "./schema", dir], { cwd: TOOLS, env: OFFLINE, encoding: "utf-8", maxBuffer: 64 << 20 }));
  const crd = parseYAML(readFileSync(join(dir, "config/prow/cluster/prowjob-crd/prowjob_customresourcedefinition.yaml"), "utf-8")) as Node;
  const out = vendorSchemas({ kinds, crd, version: prowVersion() });
  writeFileSync(join(SPEC_DIR, "job-config.schema.json"), out.jobConfig);
  writeFileSync(join(SPEC_DIR, "prowjob-spec.schema.json"), out.prowJobSpec);
  console.error(`wrote job-config.schema.json and prowjob-spec.schema.json from sigs.k8s.io/prow ${prowVersion()}`);
}
