/**
 * k3s CLI flag-definition parser.
 *
 * The spec is the pinned Go source of pkg/cli/cmds (#1599): urfave/cli
 * struct literals carrying Name, Usage, Value and Hidden. This parser
 * extracts the server and agent flag lists, resolves shared flag-var
 * references across the fetched files, and produces one entity per config
 * document k3s consumes:
 *
 *   K3s::Server     — /etc/rancher/k3s/config.yaml for `k3s server`
 *   K3s::Agent      — /etc/rancher/k3s/config.yaml for `k3s agent`
 *   K3s::Registries — /etc/rancher/k3s/registries.yaml
 *
 * registries.yaml has no flag surface; its shape is hand-typed from the
 * documented structure (docs.k3s.io/installation/private-registry) and
 * pinned by the same release constant.
 *
 * ## The token boundary (#1601)
 *
 * `token`, `agent-token` and the deprecated `cluster-secret` are excluded
 * from the typed surface on purpose. A literal shared secret in an emitted
 * config.yaml is the #1365 wall; the reference forms (`token-file`,
 * `agent-token-file`, and the K3S_TOKEN/K3S_TOKEN_FILE env vars at install
 * time) stay. K3SC001 catches a literal that arrives through a raw prop
 * anyway.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";

// ── Result types (ParsedResult contract) ───────────────────────────

export interface ParsedProperty {
  name: string;
  tsType: string;
  required: boolean;
  description?: string;
  enum?: string[];
  constraints: PropertyConstraints;
}

export interface ParsedPropertyType {
  name: string;
  defType: string;
  properties: ParsedProperty[];
}

export interface ParsedResource {
  typeName: string;
  description?: string;
  properties: ParsedProperty[];
  attributes: Array<{ name: string; tsType: string }>;
  deprecatedProperties: string[];
}

export interface K3sParseResult {
  resource: ParsedResource;
  propertyTypes: ParsedPropertyType[];
  enums: Array<{ name: string; values: string[] }>;
  isProperty?: boolean;
  warnings?: string[];
}

// ── Flag extraction ────────────────────────────────────────────────

interface FlagDef {
  varName?: string;
  flagType: string; // String | StringSlice | Int | Bool | Duration | Float64 | ...
  name?: string;
  usage?: string;
  value?: string;
  hidden: boolean;
}

/**
 * Config keys that must not reach the typed surface.
 *
 * - `config`: the --config flag itself — a config file naming its own path
 *   is not a property.
 * - `token` / `agent-token` / `cluster-secret`: literal shared secrets;
 *   see the module doc.
 * - `help`: urfave built-in.
 */
const SKIP_KEYS = new Set(["config", "token", "agent-token", "cluster-secret", "help"]);

/**
 * Extract every `&cli.<T>Flag{...}` literal in a Go source text, keyed by
 * the variable name it is assigned to when there is one.
 */
export function extractFlagLiterals(text: string): { byVar: Map<string, FlagDef>; all: FlagDef[] } {
  const byVar = new Map<string, FlagDef>();
  const all: FlagDef[] = [];
  const re = /(?:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)?&cli\.([A-Za-z0-9]+)Flag\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const bodyStart = m.index + m[0].length;
    const body = balancedBody(text, bodyStart);
    if (body === null) continue;
    const def = parseFlagBody(m[2], body);
    if (m[1]) {
      def.varName = m[1];
      byVar.set(m[1], def);
    }
    all.push(def);
    re.lastIndex = bodyStart + body.length;
  }
  return { byVar, all };
}

/** Return the text between an opening brace's position and its matching `}` (exclusive). */
function balancedBody(text: string, start: number): string | null {
  let depth = 1;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i);
    }
  }
  return null;
}

function parseFlagBody(flagType: string, body: string): FlagDef {
  const def: FlagDef = { flagType, hidden: /(^|\n)\s*Hidden:\s*true\s*,/.test(body) };

  const name = body.match(/(^|\n)\s*Name:\s*"([^"]+)"/);
  if (name) def.name = name[2];

  // Usage may be a multi-line concatenation of string literals; join every
  // quoted segment between `Usage:` and the next field key at line start.
  const usageStart = body.search(/(^|\n)\s*Usage:/);
  if (usageStart >= 0) {
    const rest = body.slice(usageStart);
    const end = rest.slice(1).search(/\n\s*[A-Z][A-Za-z]*:\s/);
    const segment = end >= 0 ? rest.slice(0, end + 1) : rest;
    const parts = [...segment.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((s) => s[1]);
    if (parts.length > 0) def.usage = parts.join("").replace(/\\"/g, '"');
  }

  const value = body.match(/(^|\n)\s*Value:\s*([^,\n]+)/);
  if (value) {
    const raw = value[2].trim();
    const str = raw.match(/^"([^"]*)"$/);
    if (str) def.value = str[1];
    else if (/^[\d.]+$/.test(raw)) def.value = raw;
    else if (/^(true|false)$/.test(raw)) def.value = raw;
    // Composite defaults (cli.NewStringSlice(...), consts) are dropped —
    // they document poorly as a bare expression.
  }

  return def;
}

/**
 * Extract the ordered item list of a `[]cli.Flag{...}` block starting at
 * `startIndex` (the index of the opening brace + 1). Items are either
 * bare identifiers (shared flag vars) or inline `&cli.*Flag{...}` literals.
 */
export function extractFlagList(text: string, marker: string | RegExp): Array<string | FlagDef> {
  const idx = typeof marker === "string" ? text.indexOf(marker) : (text.match(marker)?.index ?? -1);
  if (idx < 0) return [];
  const open = text.indexOf("{", idx + (typeof marker === "string" ? marker.length - 1 : 0));
  if (open < 0) return [];
  const body = balancedBody(text, open + 1);
  if (body === null) return [];

  const items: Array<string | FlagDef> = [];
  const re = /(?:^|\n)\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s*,|&cli\.([A-Za-z0-9]+)Flag\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) {
      items.push(m[1]);
      continue;
    }
    const bodyStart = m.index + m[0].length;
    const flagBody = balancedBody(body, bodyStart);
    if (flagBody === null) continue;
    items.push(parseFlagBody(m[2], flagBody));
    re.lastIndex = bodyStart + flagBody.length;
  }
  return items;
}

// ── Flag → property mapping ────────────────────────────────────────

function tsTypeFor(flagType: string): string {
  switch (flagType) {
    case "String":
      return "string";
    case "Int":
    case "Int64":
    case "Uint":
    case "Float64":
      return "number";
    case "Bool":
      return "boolean";
    // config.yaml accepts a single value or a list for slice flags.
    case "StringSlice":
      return "string | string[]";
    case "IntSlice":
      return "number | number[]";
    // Durations are Go duration strings ("12h", "5m") in YAML.
    case "Duration":
      return "string";
    default:
      return "string";
  }
}

function toProperty(def: FlagDef): ParsedProperty | null {
  if (!def.name || def.hidden) return null;
  // urfave v2 keeps aliases in Aliases, not the Name — but keep the guard
  // for a comma form arriving through an older definition.
  const name = def.name.split(",")[0].trim();
  if (SKIP_KEYS.has(name)) return null;
  if (def.usage && /\(deprecated/i.test(def.usage)) return null;

  let description = def.usage;
  if (def.value !== undefined && def.value !== "" && description) {
    description += ` (default: ${def.value})`;
  }

  return {
    name,
    tsType: tsTypeFor(def.flagType),
    required: false,
    description,
    constraints: {},
  };
}

function resolveList(
  items: Array<string | FlagDef>,
  byVar: Map<string, FlagDef>,
  warnings: string[],
  context: string,
): ParsedProperty[] {
  const props: ParsedProperty[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let def: FlagDef | undefined;
    if (typeof item === "string") {
      def = byVar.get(item);
      if (!def) {
        warnings.push(`${context}: unresolved flag reference ${item}`);
        continue;
      }
    } else {
      def = item;
    }
    const prop = toProperty(def);
    if (!prop || seen.has(prop.name)) continue;
    seen.add(prop.name);
    props.push(prop);
  }
  return props;
}

// ── Hand-typed registries.yaml surface ─────────────────────────────

function prop(name: string, tsType: string, description: string, required = false): ParsedProperty {
  return { name, tsType, required, description, constraints: {} };
}

function registriesEntities(): K3sParseResult[] {
  const mk = (
    typeName: string,
    description: string,
    properties: ParsedProperty[],
    isProperty = true,
  ): K3sParseResult => ({
    resource: { typeName, description, properties, attributes: [], deprecatedProperties: [] },
    propertyTypes: [],
    enums: [],
    isProperty,
  });

  return [
    mk(
      "K3s::Registries",
      "Private registry configuration (/etc/rancher/k3s/registries.yaml) for the embedded containerd",
      [
        prop("mirrors", "Record<string, Mirror>", "Registry name (or wildcard) to mirror configuration"),
        prop("configs", "Record<string, RegistryConfig>", "Registry endpoint to auth/TLS configuration"),
      ],
      false,
    ),
    mk("K3s::Mirror", "Endpoint rewrites for one registry", [
      prop("endpoint", "string | string[]", "Mirror endpoint URLs, tried in order"),
      prop("rewrite", "Record<string, string>", "Image name rewrite rules (regex to replacement)"),
    ]),
    mk("K3s::RegistryConfig", "Auth and TLS for one registry endpoint", [
      prop("auth", "RegistryAuth", "Credentials for the registry"),
      prop("tls", "RegistryTLS", "TLS settings for the registry"),
    ]),
    mk("K3s::RegistryAuth", "Registry credentials — prefer out-of-band credential helpers; K3SC002 flags literals", [
      prop("username", "string", "Basic auth username"),
      prop("password", "string", "Basic auth password. A literal here fails K3SC002"),
      prop("token", "string", "Bearer token. A literal here fails K3SC002"),
    ]),
    mk("K3s::RegistryTLS", "Registry TLS settings", [
      prop("cert_file", "string", "Client certificate path on the node"),
      prop("key_file", "string", "Client key path on the node"),
      prop("ca_file", "string", "CA bundle path on the node"),
      prop("insecure_skip_verify", "boolean", "Skip TLS verification. K3SS002 flags this"),
    ]),
  ];
}

// ── Entry point ────────────────────────────────────────────────────

/**
 * Parse the fetched spec envelope (filename → Go source) into the k3s
 * entity results.
 */
export function parseSpecFiles(data: string | Buffer): K3sParseResult[] {
  const files: Record<string, string> = JSON.parse(
    typeof data === "string" ? data : data.toString("utf-8"),
  );
  const combined = Object.values(files).join("\n");
  const warnings: string[] = [];

  const { byVar } = extractFlagLiterals(combined);

  const serverItems = extractFlagList(files["server.go"] ?? "", "var ServerFlags = []cli.Flag{");
  const serverProps = resolveList(serverItems, byVar, warnings, "ServerFlags");

  const agentItems = extractFlagList(files["agent.go"] ?? "", /Flags:\s*\[\]cli\.Flag\{/);
  const agentProps = resolveList(agentItems, byVar, warnings, "AgentFlags");

  // An agent is nothing without the server it joins. `token-file` stays
  // optional because the join secret may arrive as K3S_TOKEN_FILE at
  // install time instead (#1601).
  for (const p of agentProps) {
    if (p.name === "server") p.required = true;
  }

  const results: K3sParseResult[] = [
    {
      resource: {
        typeName: "K3s::Server",
        description: `k3s server configuration (/etc/rancher/k3s/config.yaml) — every \`k3s server\` flag as a YAML key`,
        properties: serverProps,
        attributes: [],
        deprecatedProperties: [],
      },
      propertyTypes: [],
      enums: [],
      warnings,
    },
    {
      resource: {
        typeName: "K3s::Agent",
        description: `k3s agent configuration (/etc/rancher/k3s/config.yaml) — every \`k3s agent\` flag as a YAML key`,
        properties: agentProps,
        attributes: [],
        deprecatedProperties: [],
      },
      propertyTypes: [],
      enums: [],
    },
    ...registriesEntities(),
  ];

  return results;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Extract short name: "K3s::Server" → "Server" */
export function k3sShortName(typeName: string): string {
  const parts = typeName.split("::");
  return parts[parts.length - 1];
}

/** Extract service name: always "K3s" — the lexicon is a single flat service. */
export function k3sServiceName(_typeName: string): string {
  return "K3s";
}
