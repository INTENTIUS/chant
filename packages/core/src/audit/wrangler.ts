/**
 * Wrangler config audit (#446) — a config format the audit engine could not
 * parse at all before this: `wrangler.toml`, Cloudflare Workers' native
 * declarative deploy file (routes, bindings, vars, observability). Fitting,
 * since chant's own hosted audit path targets the same Workers runtime.
 *
 * Follows `secrets.ts`'s precedent for a format the issue says should ship
 * "only a detector and a set of checks — no authoring surface, no output
 * serializer": no lexicon plugin, no `AuditInput`/`classifyFiles` involvement,
 * no npm package to install. `auditWranglerConfigs` scans the raw candidate
 * files directly (the detector is `isWranglerConfigPath`) and is called
 * alongside `scanForSecrets` from the CLI. `wrangler.toml` is also NOT the
 * `fly` lexicon's `.fly` (this repo already has a `fly` lexicon covering the
 * Machines/flaps REST API with its own `FLY0xx` ids) — this module owns a
 * disjoint namespace (`WRG0xx`) and `AuditFinding.lexicon = "wrangler"`.
 *
 * Pure: no fs, no network, no Node-only global — Workers-safe (epic #350).
 */

import { parseTOML, TomlParseError } from "../toml";
import type { AuditFinding } from "./core";

/** The minimal file shape the scanner needs (matches `discover.ts`'s `RepoFile`). */
export interface ScannableFile {
  path: string;
  content: string;
}

/** Detector: does this path look like a Wrangler config? (native TOML only — see module doc.) */
export function isWranglerConfigPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return base === "wrangler.toml";
}

type JsonRecord = Record<string, unknown>;

function isRecord(v: unknown): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** One config scope: the top-level document, or one `[env.<name>]` block. */
interface Scope {
  /** `"top-level"`, or the env name (`"production"`, `"staging"`, …). */
  name: string;
  /** Whether this scope is the account's default deploy target (`wrangler deploy` with no `--env`). */
  isTopLevel: boolean;
  config: JsonRecord;
}

function scopesOf(doc: JsonRecord): Scope[] {
  const scopes: Scope[] = [{ name: "top-level", isTopLevel: true, config: doc }];
  const env = doc.env;
  if (isRecord(env)) {
    for (const [name, cfg] of Object.entries(env)) {
      if (isRecord(cfg)) scopes.push({ name, isTopLevel: false, config: cfg });
    }
  }
  return scopes;
}

const PROD_NAME_RE = /^(prod|production|live)$/i;
const NON_PROD_NAME_RE = /^(dev|development|staging|stage|preview|test|testing|sandbox|local)$/i;

/** Best-effort 1-based line number of the first line containing `needle`, or undefined. */
function lineOf(content: string, needle: string): number | undefined {
  if (!needle) return undefined;
  const idx = content.indexOf(needle);
  if (idx === -1) return undefined;
  return content.slice(0, idx).split("\n").length;
}

// ── WRG001: workers_dev in a production-named environment ──────────────────

function checkWorkersDevInProd(file: ScannableFile, doc: JsonRecord): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const scope of scopesOf(doc)) {
    if (!PROD_NAME_RE.test(scope.name)) continue;
    if (scope.config.workers_dev !== true) continue;
    out.push({
      checkId: "WRG001",
      severity: "warning",
      message: `Environment "${scope.name}" sets workers_dev = true — the Worker is reachable on the public *.workers.dev subdomain, bypassing whatever access control a custom domain/zone would provide.`,
      file: file.path,
      lexicon: "wrangler",
      entity: scope.name,
      line: lineOf(file.content, "workers_dev"),
    });
  }
  return out;
}

// ── WRG002: sensitive-named key stored in [vars] instead of a secret ───────

const SENSITIVE_VAR_RE = /(SECRET|TOKEN|API[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|\bAUTH\b)/i;

function checkSecretShapedVars(file: ScannableFile, doc: JsonRecord): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const scope of scopesOf(doc)) {
    const vars = scope.config.vars;
    if (!isRecord(vars)) continue;
    for (const key of Object.keys(vars)) {
      if (!SENSITIVE_VAR_RE.test(key)) continue;
      out.push({
        checkId: "WRG002",
        severity: "error",
        message: `"${key}" in [vars] (${scope.name}) looks like a credential name. Plaintext vars are committed to source and visible via 'wrangler dev'/the dashboard — use 'wrangler secret put ${key}' instead.`,
        file: file.path,
        lexicon: "wrangler",
        entity: key,
        line: lineOf(file.content, key),
      });
    }
  }
  return out;
}

// ── WRG003: observability explicitly disabled ───────────────────────────────

function checkObservabilityDisabled(file: ScannableFile, doc: JsonRecord): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const scope of scopesOf(doc)) {
    const obs = scope.config.observability;
    if (!isRecord(obs)) continue;
    if (obs.enabled !== false) continue;
    out.push({
      checkId: "WRG003",
      severity: "info",
      message: `Environment "${scope.name}" explicitly disables observability (observability.enabled = false) — no Workers Logs are recorded for this deployment, which will slow down or block incident investigation.`,
      file: file.path,
      lexicon: "wrangler",
      entity: scope.name,
      line: lineOf(file.content, "observability"),
    });
  }
  return out;
}

// ── WRG004: an account-wide wildcard route (unrestricted ingress) ──────────

function routePatterns(config: JsonRecord): string[] {
  const patterns: string[] = [];
  for (const r of asArray(config.routes)) {
    if (typeof r === "string") patterns.push(r);
    else if (isRecord(r) && typeof r.pattern === "string") patterns.push(r.pattern);
  }
  if (typeof config.route === "string") patterns.push(config.route);
  return patterns;
}

/** A route pattern with no host scoping at all — matches every zone in the account, not just one. */
function isAccountWildcard(pattern: string): boolean {
  const p = pattern.trim();
  return p === "*" || p === "*/*";
}

function checkWildcardRoute(file: ScannableFile, doc: JsonRecord): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const scope of scopesOf(doc)) {
    for (const pattern of routePatterns(scope.config)) {
      if (!isAccountWildcard(pattern)) continue;
      out.push({
        checkId: "WRG004",
        severity: "error",
        message: `Environment "${scope.name}" declares route "${pattern}" — an unscoped wildcard that matches every zone/path on the account, not one domain. Scope it to a specific zone (e.g. "example.com/*").`,
        file: file.path,
        lexicon: "wrangler",
        entity: scope.name,
        line: lineOf(file.content, pattern),
      });
    }
  }
  return out;
}

// ── WRG005: a non-prod environment shares a data-store id with production ──

interface BindingSpec {
  key: string;
  idField: string;
}
const BINDING_KINDS: BindingSpec[] = [
  { key: "kv_namespaces", idField: "id" },
  { key: "r2_buckets", idField: "bucket_name" },
  { key: "d1_databases", idField: "database_id" },
];

function checkCrossEnvSharedResource(file: ScannableFile, doc: JsonRecord): AuditFinding[] {
  const out: AuditFinding[] = [];
  const scopes = scopesOf(doc);
  // The top-level scope is the default deploy target (`wrangler deploy` with
  // no `--env`) — treated as "production" only when the file also declares at
  // least one dev/staging-like env, so a single-environment file (top-level
  // only) never trips this on itself.
  const hasNonProdEnv = scopes.some((s) => !s.isTopLevel && NON_PROD_NAME_RE.test(s.name));
  const prodScopeNames = new Set(
    scopes.filter((s) => (s.isTopLevel && hasNonProdEnv) || PROD_NAME_RE.test(s.name)).map((s) => s.name),
  );
  const nonProdScopes = scopes.filter((s) => NON_PROD_NAME_RE.test(s.name));
  if (prodScopeNames.size === 0 || nonProdScopes.length === 0) return out;

  for (const { key, idField } of BINDING_KINDS) {
    // id -> set of scope names that declare a binding with that id
    const byId = new Map<string, Set<string>>();
    for (const scope of scopes) {
      for (const binding of asArray(scope.config[key])) {
        if (!isRecord(binding)) continue;
        const id = binding[idField];
        if (typeof id !== "string" || id === "") continue;
        const owners = byId.get(id) ?? new Set<string>();
        owners.add(scope.name);
        byId.set(id, owners);
      }
    }
    for (const [id, owners] of byId) {
      const prodOwner = [...owners].find((n) => prodScopeNames.has(n));
      const nonProdOwner = [...owners].find((n) => NON_PROD_NAME_RE.test(n));
      if (!prodOwner || !nonProdOwner) continue;
      out.push({
        checkId: "WRG005",
        severity: "error",
        message: `"${nonProdOwner}" and "${prodOwner}" both bind ${key} ${idField}="${id}" — the non-production environment has full read/write access to the production data store instead of its own copy.`,
        file: file.path,
        lexicon: "wrangler",
        entity: `${key}:${id}`,
        line: lineOf(file.content, id),
      });
    }
  }
  return out;
}

// ── WRG006: static assets/site served from the project root ────────────────

const ROOT_DIR_RE = /^\.?\/?$/;

function checkAssetsServeRoot(file: ScannableFile, doc: JsonRecord): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const scope of scopesOf(doc)) {
    const candidates: Array<{ table: string; field: string; value: unknown }> = [];
    if (isRecord(scope.config.site)) candidates.push({ table: "site", field: "bucket", value: scope.config.site.bucket });
    if (isRecord(scope.config.assets)) candidates.push({ table: "assets", field: "directory", value: scope.config.assets.directory });
    for (const c of candidates) {
      if (typeof c.value !== "string" || !ROOT_DIR_RE.test(c.value)) continue;
      out.push({
        checkId: "WRG006",
        severity: "warning",
        message: `Environment "${scope.name}" sets [${c.table}].${c.field} = "${c.value}" — the project root is served as public static assets, including any files not meant to be public (config, source maps, .git).`,
        file: file.path,
        lexicon: "wrangler",
        entity: scope.name,
        line: lineOf(file.content, c.field),
      });
    }
  }
  return out;
}

const CHECKS: Array<(file: ScannableFile, doc: JsonRecord) => AuditFinding[]> = [
  checkWorkersDevInProd,
  checkSecretShapedVars,
  checkObservabilityDisabled,
  checkWildcardRoute,
  checkCrossEnvSharedResource,
  checkAssetsServeRoot,
];

/**
 * Audit every `wrangler.toml` in `files`. Pure with respect to the filesystem
 * and network. A file that fails to parse contributes no findings — the audit
 * contract is "runs against any repo," never a crash on odd/partial config.
 */
export function auditWranglerConfigs(files: ScannableFile[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const file of files) {
    if (!isWranglerConfigPath(file.path)) continue;
    let doc: JsonRecord;
    try {
      doc = parseTOML(file.content);
    } catch (err) {
      if (err instanceof TomlParseError) continue;
      throw err;
    }
    for (const check of CHECKS) findings.push(...check(file, doc));
  }
  return findings;
}
