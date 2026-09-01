/**
 * nginx config audit (#1979, the #446 follow-up) — the second spike-gated
 * format after Wrangler (PR #1978). nginx's native config is a directive/block
 * DSL no structured-data parser reads, so before this the audit engine could
 * fetch an estate's `nginx.conf` but not see inside it.
 *
 * Follows `wrangler.ts`'s shape exactly: no lexicon plugin, no
 * `AuditInput`/`classifyFiles` involvement, no npm package. A principled,
 * dependency-free recursive-descent parser (directives end with `;`, blocks
 * nest with `{}`, `#` comments, single/double quotes) feeds a fixed check
 * list; `auditNginxConfigs` is called alongside `auditWranglerConfigs` from
 * the CLI. Disjoint id namespace (`NGX0xx`), `AuditFinding.lexicon = "nginx"`.
 *
 * Detection is two-stage on purpose: the *path* detector is broad (`.conf`
 * under nginx-ish directories), because `conf.d/`-style names are shared with
 * unrelated software (systemd drop-ins are `.conf` too) — so a candidate only
 * produces findings when its parsed form also carries an nginx marker
 * directive (`http`, `server`, `location`, `upstream`, …). A file that fails
 * to parse, or parses to something that isn't nginx, contributes nothing:
 * the audit contract is "runs against any repo," never a crash on odd config.
 *
 * Pure: no fs, no network, no Node-only global — Workers-safe (epic #350).
 */

import type { AuditFinding } from "./core";

/** The minimal file shape the scanner needs (matches `discover.ts`'s `RepoFile`). */
export interface ScannableFile {
  path: string;
  content: string;
}

/** nginx-ish directories whose `.conf` files are candidates. */
const NGINX_DIR_RE = /(^|\/)(nginx|conf\.d|sites-available|sites-enabled|snippets)(\/|$)/;

/** Detector: does this path look like nginx config? (Confirmed by content markers at parse time.) */
export function isNginxConfigPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (base === "nginx.conf") return true;
  return base.endsWith(".conf") && NGINX_DIR_RE.test(path.slice(0, path.length - base.length));
}

// ── Parser ──────────────────────────────────────────────────────────────────

/** One parsed directive. A block directive (`server { … }`) carries `block`. */
export interface NginxDirective {
  name: string;
  args: string[];
  block?: NginxDirective[];
  /** 1-based line the directive's name starts on. */
  line: number;
}

export class NginxParseError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = "NginxParseError";
  }
}

interface Token {
  value: string;
  line: number;
  kind: "word" | "{" | "}" | ";";
}

function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    if (c === "\n") {
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      i++;
    } else if (c === "#") {
      while (i < n && content[i] !== "\n") i++;
    } else if (c === "{" || c === "}" || c === ";") {
      tokens.push({ value: c, line, kind: c });
      i++;
    } else if (c === '"' || c === "'") {
      const quote = c;
      const startLine = line;
      let value = "";
      i++;
      while (i < n && content[i] !== quote) {
        if (content[i] === "\\" && i + 1 < n) {
          value += content[i + 1];
          if (content[i + 1] === "\n") line++;
          i += 2;
        } else {
          if (content[i] === "\n") line++;
          value += content[i];
          i++;
        }
      }
      if (i >= n) throw new NginxParseError("Unterminated quoted string", startLine);
      i++; // closing quote
      tokens.push({ value, line: startLine, kind: "word" });
    } else {
      const start = i;
      const startLine = line;
      while (i < n && !' \t\r\n#{};"\''.includes(content[i])) i++;
      tokens.push({ value: content.slice(start, i), line: startLine, kind: "word" });
    }
  }
  return tokens;
}

/** Parse nginx config into a directive tree. Throws `NginxParseError` on malformed input. */
export function parseNginx(content: string): NginxDirective[] {
  const tokens = tokenize(content);
  let pos = 0;

  function parseDirectives(depth: number): NginxDirective[] {
    const out: NginxDirective[] = [];
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.kind === "}") {
        if (depth === 0) throw new NginxParseError("Unexpected '}'", tok.line);
        pos++;
        return out;
      }
      if (tok.kind !== "word") throw new NginxParseError(`Unexpected '${tok.value}'`, tok.line);
      const name = tok.value;
      const line = tok.line;
      pos++;
      const args: string[] = [];
      for (;;) {
        if (pos >= tokens.length) throw new NginxParseError(`Directive "${name}" is never terminated`, line);
        const next = tokens[pos];
        if (next.kind === "word") {
          args.push(next.value);
          pos++;
        } else if (next.kind === ";") {
          pos++;
          out.push({ name, args, line });
          break;
        } else if (next.kind === "{") {
          pos++;
          out.push({ name, args, line, block: parseDirectives(depth + 1) });
          break;
        } else {
          throw new NginxParseError(`Unexpected '}' inside directive "${name}"`, next.line);
        }
      }
    }
    if (depth > 0) throw new NginxParseError("Unclosed '{'", tokens[tokens.length - 1]?.line ?? 1);
    return out;
  }

  return parseDirectives(0);
}

// ── Walk helpers ────────────────────────────────────────────────────────────

/** Directive names that confirm a parsed `.conf` is actually nginx. */
const NGINX_MARKERS = new Set(["http", "server", "location", "upstream", "events", "stream", "listen", "proxy_pass", "server_name"]);

function hasNginxMarker(tree: NginxDirective[]): boolean {
  return tree.some((d) => NGINX_MARKERS.has(d.name) || (d.block !== undefined && hasNginxMarker(d.block)));
}

/** Depth-first visit of every directive with its ancestor block-name chain. */
function walk(tree: NginxDirective[], visit: (d: NginxDirective, ancestors: string[]) => void, ancestors: string[] = []): void {
  for (const d of tree) {
    visit(d, ancestors);
    if (d.block) walk(d.block, visit, [...ancestors, d.name]);
  }
}

// ── NGX001: deprecated TLS protocol enabled ─────────────────────────────────

const DEPRECATED_TLS = new Set(["sslv2", "sslv3", "tlsv1", "tlsv1.1"]);

function checkDeprecatedTls(file: ScannableFile, tree: NginxDirective[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  walk(tree, (d) => {
    if (d.name !== "ssl_protocols") return;
    const bad = d.args.filter((a) => DEPRECATED_TLS.has(a.toLowerCase()));
    if (bad.length === 0) return;
    out.push({
      checkId: "NGX001",
      severity: "error",
      message: `ssl_protocols enables ${bad.join(", ")} — protocols with known breaks (POODLE, BEAST) that every current client has moved past. Serve TLSv1.2 and TLSv1.3 only.`,
      file: file.path,
      lexicon: "nginx",
      entity: "ssl_protocols",
      line: d.line,
    });
  });
  return out;
}

// ── NGX002: weak cipher suite enabled ───────────────────────────────────────

const WEAK_CIPHER_RE = /(RC4|DES|MD5|NULL|EXPORT|LOW|aNULL|eNULL)/i;

function checkWeakCiphers(file: ScannableFile, tree: NginxDirective[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  walk(tree, (d) => {
    if (d.name !== "ssl_ciphers") return;
    // A cipher string is ':'-separated; an entry starting with '!' is an
    // exclusion (good), so only positive entries can be findings.
    const weak = d.args
      .flatMap((a) => a.split(":"))
      .filter((s) => s !== "" && !s.startsWith("!") && WEAK_CIPHER_RE.test(s));
    if (weak.length === 0) return;
    out.push({
      checkId: "NGX002",
      severity: "error",
      message: `ssl_ciphers enables weak suite(s): ${[...new Set(weak)].join(", ")} — breakable ciphers (RC4/DES/MD5/NULL/EXPORT classes) undermine every connection that negotiates one. Use a modern cipher list.`,
      file: file.path,
      lexicon: "nginx",
      entity: "ssl_ciphers",
      line: d.line,
    });
  });
  return out;
}

// ── NGX003: directory listing enabled ───────────────────────────────────────

function checkAutoindex(file: ScannableFile, tree: NginxDirective[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  walk(tree, (d, ancestors) => {
    if (d.name !== "autoindex" || d.args[0]?.toLowerCase() !== "on") return;
    out.push({
      checkId: "NGX003",
      severity: "warning",
      message: `autoindex on (${ancestors.join(" > ") || "top level"}) — the directory's full file listing is served to anyone, including files never meant to be enumerated.`,
      file: file.path,
      lexicon: "nginx",
      entity: "autoindex",
      line: d.line,
    });
  });
  return out;
}

// ── NGX004: alias path traversal (the gixy classic) ─────────────────────────

/** Location args end with the prefix; earlier args are modifiers (`=`, `^~`, `~`, `~*`). */
function locationPrefix(args: string[]): { prefix: string; isRegex: boolean } | undefined {
  if (args.length === 0) return undefined;
  const modifiers = args.slice(0, -1);
  return { prefix: args[args.length - 1], isRegex: modifiers.includes("~") || modifiers.includes("~*") };
}

function checkAliasTraversal(file: ScannableFile, tree: NginxDirective[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  walk(tree, (d) => {
    if (d.name !== "location" || !d.block) return;
    const loc = locationPrefix(d.args);
    if (!loc || loc.isRegex || loc.prefix.endsWith("/")) return;
    for (const inner of d.block) {
      if (inner.name !== "alias") continue;
      const target = inner.args[0] ?? "";
      if (!target.endsWith("/")) continue;
      out.push({
        checkId: "NGX004",
        severity: "error",
        message: `location "${loc.prefix}" (no trailing slash) with alias "${target}" — a request for "${loc.prefix}../" resolves outside the aliased directory (path traversal). End the location prefix with "/" to match the alias.`,
        file: file.path,
        lexicon: "nginx",
        entity: loc.prefix,
        line: inner.line,
      });
    }
  });
  return out;
}

// ── NGX005: status endpoint with no access restriction ──────────────────────

function checkOpenStatusEndpoint(file: ScannableFile, tree: NginxDirective[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  walk(tree, (d) => {
    if (d.name !== "location" || !d.block) return;
    const hasStatus = d.block.some((inner) => inner.name === "stub_status");
    if (!hasStatus) return;
    const restricted = d.block.some(
      (inner) => inner.name === "deny" || inner.name === "allow" || inner.name === "auth_basic" || inner.name === "auth_request",
    );
    if (restricted) return;
    out.push({
      checkId: "NGX005",
      severity: "warning",
      message: `stub_status in location "${d.args[d.args.length - 1] ?? ""}" with no allow/deny or auth — the server's connection metrics are readable by anyone, a reconnaissance gift.`,
      file: file.path,
      lexicon: "nginx",
      entity: "stub_status",
      line: d.line,
    });
  });
  return out;
}

// ── NGX006: server version disclosure (server_tokens not disabled) ──────────

function checkServerTokens(file: ScannableFile, tree: NginxDirective[]): AuditFinding[] {
  const http = tree.find((d) => d.name === "http" && d.block);
  if (!http) return []; // a partial include has no http{} — the main conf is where this belongs
  let disabled = false;
  walk(tree, (d) => {
    if (d.name === "server_tokens" && d.args[0]?.toLowerCase() !== "on") disabled = true;
  });
  if (disabled) return [];
  return [
    {
      checkId: "NGX006",
      severity: "info",
      message: `server_tokens is not disabled — nginx defaults to advertising its exact version in the Server header and error pages, handing scanners a version to match CVEs against. Add "server_tokens off;" in the http block.`,
      file: file.path,
      lexicon: "nginx",
      entity: "http",
      line: http.line,
    },
  ];
}

// ── NGX007: access logging disabled at server scope ─────────────────────────

function checkAccessLogOff(file: ScannableFile, tree: NginxDirective[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  walk(tree, (d, ancestors) => {
    if (d.name !== "access_log" || d.args[0]?.toLowerCase() !== "off") return;
    // Silencing a single noisy location (favicon, health checks) is normal
    // practice; going dark at http/server scope is what blocks investigation.
    const scope = ancestors[ancestors.length - 1] ?? "top level";
    if (scope === "location") return;
    out.push({
      checkId: "NGX007",
      severity: "info",
      message: `access_log off at ${scope} scope — no requests are recorded for this ${scope === "server" ? "server" : "configuration"}, which will slow down or block incident investigation.`,
      file: file.path,
      lexicon: "nginx",
      entity: scope,
      line: d.line,
    });
  });
  return out;
}

const CHECKS: Array<(file: ScannableFile, tree: NginxDirective[]) => AuditFinding[]> = [
  checkDeprecatedTls,
  checkWeakCiphers,
  checkAutoindex,
  checkAliasTraversal,
  checkOpenStatusEndpoint,
  checkServerTokens,
  checkAccessLogOff,
];

/**
 * Audit every nginx config in `files`. Pure with respect to the filesystem
 * and network. A candidate that fails to parse, or parses to something with
 * no nginx marker directive (a systemd-style `.conf` in a `conf.d/`),
 * contributes no findings.
 */
export function auditNginxConfigs(files: ScannableFile[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const file of files) {
    if (!isNginxConfigPath(file.path)) continue;
    let tree: NginxDirective[];
    try {
      tree = parseNginx(file.content);
    } catch (err) {
      if (err instanceof NginxParseError) continue;
      throw err;
    }
    if (!hasNginxMarker(tree)) continue;
    for (const check of CHECKS) findings.push(...check(file, tree));
  }
  return findings;
}
