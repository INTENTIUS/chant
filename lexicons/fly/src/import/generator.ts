/**
 * flaps TypeScript generator.
 *
 * Converts import IR from {@link FlyParser} into typed chant TypeScript:
 * `import { App, Machine, ... } from "@intentius/chant-lexicon-fly";` followed by
 * `export const <var> = new <Class>({ ... });`.
 *
 * fly's nested config types (`MachineConfig`, `MachineGuest`, `MachineService`,
 * ...) are property declarables — classes with an empty instance shape — so a
 * bare object literal would trip TypeScript's excess-property check against the
 * declared parameter type. Wherever a field's declared type is one of those
 * classes, the value is wrapped in `new <Class>({ ... })` (recursively), which is
 * the same authoring surface `chant init` scaffolds and the serializer walks back
 * to the identical flaps body.
 */

import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";

/**
 * How a nested field is wrapped: `single` → `new Cls({...})`, `array` → each
 * element wrapped, `record` → each value wrapped.
 */
type Nested = { kind: "single" | "array" | "record"; cls: string };

/**
 * `<OwnerClass> → { <field>: { kind, cls } }` for every field whose declared
 * type is a fly property declarable (a class, an array of one, or a
 * `Record<string, one>`). Mirrors the constructor parameter types in the
 * generated resource classes (src/generated). Regenerate this map if the pinned
 * flaps spec changes the config surface.
 */
const NESTED_DECLARABLES: Record<string, Record<string, Nested>> = {
  Machine: {
    config: { kind: "single", cls: "MachineConfig" },
  },
  Volume: {
    compute: { kind: "single", cls: "MachineGuest" },
  },
  ContainerConfig: {
    depends_on: { kind: "array", cls: "ContainerDependency" },
    env_from: { kind: "array", cls: "EnvFrom" },
    files: { kind: "array", cls: "File" },
    healthchecks: { kind: "array", cls: "ContainerHealthcheck" },
    restart: { kind: "single", cls: "MachineRestart" },
    secrets: { kind: "array", cls: "MachineSecret" },
    stop: { kind: "single", cls: "StopConfig" },
  },
  ContainerHealthcheck: {
    exec: { kind: "single", cls: "ExecHealthcheck" },
    http: { kind: "single", cls: "HTTPHealthcheck" },
    tcp: { kind: "single", cls: "TCPHealthcheck" },
  },
  DNSConfig: {
    dns_forward_rules: { kind: "array", cls: "DnsForwardRule" },
    options: { kind: "array", cls: "DnsOption" },
  },
  HTTPHealthcheck: {
    headers: { kind: "array", cls: "MachineHTTPHeader" },
  },
  HTTPOptions: {
    replay_cache: { kind: "array", cls: "ReplayCache" },
    response: { kind: "single", cls: "HTTPResponseOptions" },
  },
  MachineCheck: {
    headers: { kind: "array", cls: "MachineHTTPHeader" },
  },
  MachineConfig: {
    cache_drive: { kind: "single", cls: "MachineCacheDrive" },
    checks: { kind: "record", cls: "MachineCheck" },
    containers: { kind: "array", cls: "ContainerConfig" },
    dns: { kind: "single", cls: "DNSConfig" },
    files: { kind: "array", cls: "File" },
    guest: { kind: "single", cls: "MachineGuest" },
    init: { kind: "single", cls: "MachineInit" },
    metrics: { kind: "single", cls: "MachineMetrics" },
    mounts: { kind: "array", cls: "MachineMount" },
    processes: { kind: "array", cls: "MachineProcess" },
    restart: { kind: "single", cls: "MachineRestart" },
    rootfs: { kind: "single", cls: "MachineRootfs" },
    services: { kind: "array", cls: "MachineService" },
    spot: { kind: "single", cls: "MachineSpot" },
    statics: { kind: "array", cls: "Static" },
    stop_config: { kind: "single", cls: "StopConfig" },
  },
  MachinePort: {
    http_options: { kind: "single", cls: "HTTPOptions" },
    proxy_proto_options: { kind: "single", cls: "ProxyProtoOptions" },
    tls_options: { kind: "single", cls: "TLSOptions" },
  },
  MachineProcess: {
    env_from: { kind: "array", cls: "EnvFrom" },
    secrets: { kind: "array", cls: "MachineSecret" },
  },
  MachineService: {
    checks: { kind: "array", cls: "MachineServiceCheck" },
    concurrency: { kind: "single", cls: "MachineServiceConcurrency" },
    ports: { kind: "array", cls: "MachinePort" },
  },
  MachineServiceCheck: {
    headers: { kind: "array", cls: "MachineHTTPHeader" },
  },
};

export class FlyGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): GeneratedFile[] {
    const imports = new Set<string>();
    const bodyLines: string[] = [];

    for (const resource of ir.resources) {
      const parts = resource.type.split("::");
      const className = parts.length >= 3 ? parts[2] : resource.type;
      imports.add(className);
      const varName = camelCase(resource.logicalId);
      const props = formatProps(resource.properties, 0, className, imports);
      bodyLines.push(`export const ${varName} = new ${className}(${props});`);
      bodyLines.push("");
    }

    const lines: string[] = [];
    if (imports.size > 0) {
      lines.push(
        `import { ${[...imports].sort().join(", ")} } from "@intentius/chant-lexicon-fly";`,
      );
      lines.push("");
    }
    lines.push(...bodyLines);

    return [{ path: "main.ts", content: lines.join("\n") + "\n" }];
  }
}

function camelCase(str: string): string {
  return str
    .replace(/[-_.](.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toLowerCase());
}

/**
 * Format an object literal for the props of `ownerClass`. Fields whose declared
 * type is a nested declarable are wrapped in their constructor; everything else
 * is emitted as a plain literal.
 */
function formatProps(
  props: Record<string, unknown>,
  indent: number,
  ownerClass: string,
  imports: Set<string>,
): string {
  const entries = Object.entries(props);
  if (entries.length === 0) return "{}";

  const pad = "  ".repeat(indent + 1);
  const closePad = "  ".repeat(indent);
  const nested = NESTED_DECLARABLES[ownerClass];

  const lines = entries.map(([key, value]) => {
    const spec = nested?.[key];
    const rendered =
      spec !== undefined
        ? formatNested(value, indent + 1, spec, imports)
        : formatValue(value, indent + 1);
    return `${pad}${key}: ${rendered},`;
  });

  return `{\n${lines.join("\n")}\n${closePad}}`;
}

/** Wrap a nested-declarable value in its constructor per the field's kind. */
function formatNested(
  value: unknown,
  indent: number,
  spec: Nested,
  imports: Set<string>,
): string {
  const construct = (obj: unknown, at: number): string => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return formatValue(obj, at);
    }
    imports.add(spec.cls);
    return `new ${spec.cls}(${formatProps(obj as Record<string, unknown>, at, spec.cls, imports)})`;
  };

  if (spec.kind === "single") {
    return construct(value, indent);
  }

  if (spec.kind === "array") {
    if (!Array.isArray(value) || value.length === 0) return "[]";
    const pad = "  ".repeat(indent + 1);
    const closePad = "  ".repeat(indent);
    const items = value.map((v) => `${pad}${construct(v, indent + 1)},`);
    return `[\n${items.join("\n")}\n${closePad}]`;
  }

  // record: a plain object whose values are wrapped in the constructor.
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return formatValue(value, indent);
  }
  const record = value as Record<string, unknown>;
  const recKeys = Object.entries(record);
  if (recKeys.length === 0) return "{}";
  const pad = "  ".repeat(indent + 1);
  const closePad = "  ".repeat(indent);
  const items = recKeys.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${construct(v, indent + 1)},`);
  return `{\n${items.join("\n")}\n${closePad}}`;
}

function formatValue(value: unknown, indent: number): string {
  if (value === null || value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const pad = "  ".repeat(indent + 1);
    const closePad = "  ".repeat(indent);
    const items = value.map((v) => `${pad}${formatValue(v, indent + 1)},`);
    return `[\n${items.join("\n")}\n${closePad}]`;
  }

  if (typeof value === "object") {
    return formatPlainObject(value as Record<string, unknown>, indent);
  }

  return String(value);
}

/** A plain object literal (no constructor wrapping) — for scalar-valued maps like env/metadata. */
function formatPlainObject(obj: Record<string, unknown>, indent: number): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return "{}";
  const pad = "  ".repeat(indent + 1);
  const closePad = "  ".repeat(indent);
  const lines = entries.map(([key, value]) => `${pad}${objectKey(key)}: ${formatValue(value, indent + 1)},`);
  return `{\n${lines.join("\n")}\n${closePad}}`;
}

/** Emit a bare identifier key when it is a valid one, else a quoted key. */
function objectKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}
