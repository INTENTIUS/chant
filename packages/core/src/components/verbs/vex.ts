/**
 * VEX (Vulnerability Exploitability eXchange) ingestion + suppression (#626).
 * A scanner (./vuln-scan.ts) flags every known CVE in an SBOM, but most aren't
 * actually exploitable in context (unreachable code path, already mitigated,
 * false positive). VEX is where you (or upstream) assert, per CVE, whether it
 * *actually* affects this artifact. Without it a gate is CVE fatigue — 500
 * findings, 5 that matter. This module parses VEX and filters findings, and it
 * **reports** every suppression with its justification — a VEX-suppressed
 * finding is never silently dropped.
 *
 * Two formats: **OpenVEX** (the standalone Sigstore/OpenSSF format) and
 * **CycloneDX**-embedded VEX (`vulnerabilities[].analysis`). Both reduce to the
 * same `VexStatement` shape here.
 */

import type { VulnFinding } from "./vuln-scan";

/** VEX status for a CVE against an artifact. `not_affected`/`fixed` suppress a finding; `affected`/`under_investigation` keep it (conservative — an unresolved status must not hide a real vuln). */
export type VexStatus = "not_affected" | "affected" | "fixed" | "under_investigation";

/** True for statuses that suppress a matching finding from gating. */
export function suppresses(status: VexStatus): boolean {
  return status === "not_affected" || status === "fixed";
}

/** One VEX assertion: this CVE has this status for this artifact, with an optional human justification. */
export interface VexStatement {
  cveId: string;
  status: VexStatus;
  /** Why — e.g. `"vulnerable_code_not_in_execute_path"`, `"component_not_present"`. Surfaced on the suppression report so a reviewer sees the reasoning, never a bare "suppressed." */
  justification?: string;
  /** Every id the statement names the vulnerability by: its `name`, `@id` and `aliases` (OpenVEX), or its `id` (CycloneDX). Absent on a statement built by hand, which is then `cveId` alone. */
  ids?: string[];
  /** The products the statement is about, as the document names them. A scoped match ({@link applyScopedVex}) needs at least one. */
  products?: VexProduct[];
  /** Where the statement is, for messages: the file and its index, such as `vex/tofu.openvex.json#statements[0]`. */
  ref?: string;
}

/** One product a statement names: the ids it goes by (`@id`, `identifiers`), its hashes, and the subcomponents the vulnerability is in. */
export interface VexProduct {
  /** `@id` and the values of `identifiers`: purls, image references, or other names. */
  ids: string[];
  /** The values of `hashes`, such as a sha-256 digest, without the algorithm. */
  hashes: string[];
  /** Each subcomponent's ids. Empty: the statement is about the product as a whole. */
  subcomponents: string[][];
}

// ── OpenVEX ──────────────────────────────────────────────────────────────────

interface OpenVexComponent {
  "@id"?: string;
  identifiers?: Record<string, string>;
  hashes?: Record<string, string>;
  subcomponents?: OpenVexComponent[];
}

interface OpenVexDoc {
  statements?: Array<{
    // OpenVEX allows `vulnerability` as either a string or an object with `name`.
    vulnerability?: string | { name?: string; "@id"?: string; aliases?: string[] };
    status?: string;
    justification?: string;
    impact_statement?: string;
    action_statement?: string;
    products?: Array<string | OpenVexComponent>;
    // OpenVEX before v0.2.0 put subcomponents on the statement, for every product.
    subcomponents?: Array<string | OpenVexComponent>;
  }>;
}

const strings = (xs: unknown[]): string[] => xs.filter((x): x is string => typeof x === "string" && x !== "");

/** The ids a component goes by: its `@id` and its `identifiers` (purl, cpe and the like). */
function componentIds(c: string | OpenVexComponent): string[] {
  if (typeof c === "string") return strings([c]);
  if (c === null || typeof c !== "object") return [];
  return strings([c["@id"], ...Object.values(c.identifiers ?? {})]);
}

function openVexProducts(s: NonNullable<OpenVexDoc["statements"]>[number]): VexProduct[] {
  const list = <T>(x: T[] | undefined): T[] => (Array.isArray(x) ? x : []);
  const shared = list(s.subcomponents).map(componentIds).filter((ids) => ids.length > 0);
  return list(s.products).filter((p) => typeof p === "string" || (p !== null && typeof p === "object")).map((p) => {
    const own = typeof p === "string" ? [] : list(p.subcomponents).map(componentIds).filter((ids) => ids.length > 0);
    return {
      ids: componentIds(p),
      hashes: typeof p === "string" ? [] : strings(Object.values(p.hashes ?? {})),
      subcomponents: [...own, ...shared],
    };
  }).filter((p) => p.ids.length > 0 || p.hashes.length > 0);
}

function vexStatusFrom(raw: string | undefined): VexStatus | undefined {
  switch ((raw ?? "").toLowerCase()) {
    case "not_affected":
      return "not_affected";
    case "affected":
      return "affected";
    case "fixed":
      return "fixed";
    case "under_investigation":
      return "under_investigation";
    default:
      return undefined;
  }
}

/** Parse an OpenVEX JSON document into statements. Unknown statuses / statements missing a vulnerability id are skipped. */
export function parseOpenVex(bytes: string, source?: string): VexStatement[] {
  const doc = JSON.parse(bytes) as OpenVexDoc;
  const out: VexStatement[] = [];
  (doc.statements ?? []).forEach((s, i) => {
    const v = s.vulnerability;
    const cveId = typeof v === "string" ? v : (v?.name ?? v?.["@id"]);
    const status = vexStatusFrom(s.status);
    if (!cveId || !status) return;
    const ids = typeof v === "string" ? [v] : strings([v?.name, v?.["@id"], ...(Array.isArray(v?.aliases) ? v.aliases : [])]);
    out.push({ cveId, status, justification: s.justification ?? s.impact_statement, ids, products: openVexProducts(s), ...(source !== undefined ? { ref: `${source}#statements[${i}]` } : {}) });
  });
  return out;
}

// ── CycloneDX-embedded VEX ───────────────────────────────────────────────────

interface CycloneDxComponent {
  "bom-ref"?: string;
  name?: string;
  version?: string;
  purl?: string;
  hashes?: Array<{ alg?: string; content?: string }>;
  components?: CycloneDxComponent[];
}

interface CycloneDxVexDoc {
  metadata?: { component?: CycloneDxComponent };
  components?: CycloneDxComponent[];
  vulnerabilities?: Array<{
    id?: string;
    references?: Array<{ id?: string }>;
    analysis?: { state?: string; detail?: string; justification?: string };
    affects?: Array<{ ref?: string }>;
  }>;
}

/** Every component a CycloneDX document lists, nested ones included, by `bom-ref`. */
function cdxComponents(doc: CycloneDxVexDoc): Map<string, CycloneDxComponent> {
  const out = new Map<string, CycloneDxComponent>();
  const walk = (cs: CycloneDxComponent[] | undefined) => {
    for (const c of cs ?? []) {
      if (c["bom-ref"]) out.set(c["bom-ref"], c);
      walk(c.components);
    }
  };
  walk(doc.metadata?.component ? [doc.metadata.component] : []);
  walk(doc.components);
  return out;
}

/** Map CycloneDX `analysis.state` to a `VexStatus`. */
function cdxStateToVex(state: string | undefined): VexStatus | undefined {
  switch ((state ?? "").toLowerCase()) {
    case "not_affected":
    case "false_positive":
      return "not_affected";
    case "resolved":
    case "resolved_with_pedigree":
      return "fixed";
    case "exploitable":
      return "affected";
    case "in_triage":
      return "under_investigation";
    default:
      return undefined;
  }
}

/** Parse CycloneDX-embedded VEX (`vulnerabilities[].analysis`) into statements. */
/**
 * Parse CycloneDX-embedded VEX (`vulnerabilities[].analysis`) into statements.
 * The product is the document's `metadata.component`; `affects[].ref` names
 * the components the vulnerability is in, resolved through the document's
 * `bom-ref`s to their purls where it can be.
 */
export function parseCycloneDxVex(bytes: string, source?: string): VexStatement[] {
  const doc = JSON.parse(bytes) as CycloneDxVexDoc;
  const byRef = cdxComponents(doc);
  const top = doc.metadata?.component;
  const out: VexStatement[] = [];
  (doc.vulnerabilities ?? []).forEach((v, i) => {
    const status = cdxStateToVex(v.analysis?.state);
    if (!v.id || !status) return;
    const subcomponents = (Array.isArray(v.affects) ? v.affects : []).map((a) => {
      const c = a.ref ? byRef.get(a.ref) : undefined;
      if (c && c === top) return [];
      return strings([a.ref, c?.purl]);
    }).filter((ids) => ids.length > 0);
    const product: VexProduct[] = top
      ? [{ ids: strings([top.purl, top["bom-ref"], top.name && top.version ? `${top.name}:${top.version}` : undefined, top.name]), hashes: strings((top.hashes ?? []).map((h) => h.content)), subcomponents }]
      : [];
    const ids = strings([v.id, ...(v.references ?? []).map((r) => r.id)]);
    out.push({ cveId: v.id, status, justification: v.analysis?.justification ?? v.analysis?.detail, ids, products: product, ...(source !== undefined ? { ref: `${source}#vulnerabilities[${i}]` } : {}) });
  });
  return out;
}

/**
 * Parse a VEX document of either format — dispatched on shape (`statements` ->
 * OpenVEX, `vulnerabilities` -> CycloneDX). A malformed/unparseable document
 * yields NO statements (returns `[]`) rather than throwing: it therefore
 * suppresses nothing, keeping the gate strict (fail-closed) instead of
 * crashing on attacker- or typo-supplied input.
 */
export function parseVexDocument(bytes: string, source?: string): VexStatement[] {
  let doc: OpenVexDoc & CycloneDxVexDoc;
  try {
    doc = JSON.parse(bytes) as OpenVexDoc & CycloneDxVexDoc;
  } catch {
    return [];
  }
  if (Array.isArray(doc.statements)) return parseOpenVex(bytes, source);
  if (Array.isArray(doc.vulnerabilities)) return parseCycloneDxVex(bytes, source);
  return [];
}

// ── applying VEX to findings ─────────────────────────────────────────────────

/** A finding removed from gating by a VEX statement, kept for reporting (never silently dropped). */
export interface SuppressedFinding {
  finding: VulnFinding;
  status: VexStatus;
  justification?: string;
  /** The statement that cleared it ({@link VexStatement.ref}), when it has one. */
  statement?: string;
}

/** The result of filtering findings through VEX: what still gates, and what was suppressed (with reasons). */
export interface VexResult {
  /** Findings that survived VEX — the gate evaluates these. */
  gating: VulnFinding[];
  /** Findings suppressed by a `not_affected`/`fixed` statement, with the statement's justification. */
  suppressed: SuppressedFinding[];
}

/**
 * Filter `findings` through `statements`. A finding is suppressed only when
 * some statement for its CVE suppresses it (`not_affected`/`fixed`) AND **no**
 * statement for that CVE asserts it is `affected`/`under_investigation`.
 *
 * This is the conservative merge, deliberately NOT "last statement wins":
 * when VEX comes from several sources (repo-local files + referrer-attached),
 * a later `not_affected` must not be able to override an earlier `affected` to
 * unblock a real vulnerability. Merging VEX can only ever make the gate
 * *stricter*, never quietly weaker — so an attacker who can append a statement
 * cannot suppress a finding another source flagged as affected.
 */
export function applyVex(findings: VulnFinding[], statements: VexStatement[]): VexResult {
  const byCve = new Map<string, VexStatement[]>();
  for (const s of statements) {
    const list = byCve.get(s.cveId);
    if (list) list.push(s);
    else byCve.set(s.cveId, [s]);
  }
  const gating: VulnFinding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const f of findings) {
    const list = byCve.get(f.cveId) ?? [];
    const contested = list.some((s) => s.status === "affected" || s.status === "under_investigation");
    const suppressor = contested ? undefined : list.find((s) => suppresses(s.status));
    if (suppressor) {
      suppressed.push({ finding: f, status: suppressor.status, justification: suppressor.justification });
    } else {
      gating.push(f);
    }
  }
  return { gating, suppressed };
}

// ── scoped matching: a statement applies only to the products it names ──────

/** A package URL, parsed: type, namespace, name, version and qualifiers, each decoded. */
export interface Purl {
  type: string;
  namespace: string;
  name: string;
  version?: string;
  qualifiers: Record<string, string>;
}

/** Types whose namespace and name compare without case, as the purl spec says. */
const CASELESS_PURL_TYPES = new Set(["npm", "github", "gitlab", "bitbucket", "oci", "pypi", "golang", "composer", "deb", "apk", "hex"]);

const decode = (x: string): string => {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};

/** Parse a purl (`pkg:type/namespace/name@version?qualifiers#subpath`), or null when `s` is not one. */
export function parsePurl(s: string): Purl | null {
  if (!s.startsWith("pkg:")) return null;
  let rest = s.slice(4).replace(/^\/+/, "");
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const qualifiers: Record<string, string> = {};
  const q = rest.indexOf("?");
  if (q >= 0) {
    for (const pair of rest.slice(q + 1).split("&")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const value = decode(pair.slice(eq + 1));
      if (value !== "") qualifiers[pair.slice(0, eq).toLowerCase()] = value;
    }
    rest = rest.slice(0, q);
  }
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const type = rest.slice(0, slash).toLowerCase();
  let path = rest.slice(slash + 1);
  let version: string | undefined;
  const at = path.lastIndexOf("@");
  if (at > path.lastIndexOf("/") && at > 0) {
    version = decode(path.slice(at + 1));
    path = path.slice(0, at);
  }
  const segs = path.split("/").filter(Boolean).map(decode);
  const name = segs.pop();
  if (!name) return null;
  const fold = (x: string) => (CASELESS_PURL_TYPES.has(type) ? x.toLowerCase() : x);
  return { type, namespace: fold(segs.join("/")), name: fold(name), ...(version ? { version } : {}), qualifiers };
}

/**
 * Whether the purl a statement names (`want`) covers `have`, per the purl
 * spec's rule for a less specific purl: type, namespace and name equal; the
 * version, when `want` names one, equal; and every qualifier `want` names
 * present in `have` with the same value. A qualifier `want` leaves out
 * matches any value.
 */
export function purlCovers(want: Purl, have: Purl): boolean {
  if (want.type !== have.type || want.namespace !== have.namespace || want.name !== have.name) return false;
  if (want.version !== undefined && want.version !== have.version) return false;
  return Object.entries(want.qualifiers).every(([k, v]) => have.qualifiers[k] !== undefined && sameQualifier(k, v, have.qualifiers[k]!));
}

const sameQualifier = (key: string, a: string, b: string): boolean => (key === "repository_url" ? normalizeRepository(a) === normalizeRepository(b) : a === b);

/** An image repository as compared: no scheme, no trailing slash, lower case. */
export function normalizeRepository(r: string): string {
  return r.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

/** What a scan scanned, as a VEX statement's products are matched against it. */
export interface VexSubject {
  /** The image repository, such as `ghcr.io/acme/api`, for an image. */
  repository?: string;
  /** The tags the image goes out under, when known. */
  tags?: readonly string[];
  /** The digest of what was scanned, such as `sha256:...`. */
  digest?: string;
  /** Purls the artifact goes by, such as `pkg:npm/%40acme/core@1.4.0`. An image's is made from `repository` and `digest`. */
  purls?: readonly string[];
}

/** An image reference (`registry/path[:tag][@digest]`), split. */
function imageReference(s: string): { repository: string; tag?: string; digest?: string } | null {
  if (s.startsWith("pkg:") || /\s/.test(s) || !s.includes("/")) return null;
  let rest = s.replace(/^[a-z]+:\/\//i, "");
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { repository: rest, ...(tag ? { tag } : {}), ...(digest ? { digest } : {}) };
}

const bareDigest = (d: string): string => d.replace(/^sha256:/i, "").toLowerCase();

/** The purls `subject` goes by: its own, and for an image `pkg:oci/<name>@<digest>?repository_url=<repository>`, once per tag when it has tags. */
function subjectPurls(subject: VexSubject): Purl[] {
  const out = (subject.purls ?? []).map(parsePurl).filter((p): p is Purl => p !== null);
  if (subject.repository) {
    const repository = normalizeRepository(subject.repository);
    const name = repository.split("/").pop()!;
    const base = { type: "oci", namespace: "", name, ...(subject.digest ? { version: subject.digest } : {}) };
    const tags = subject.tags && subject.tags.length > 0 ? subject.tags : [undefined];
    for (const tag of tags) out.push({ ...base, qualifiers: { repository_url: repository, ...(tag ? { tag } : {}) } });
  }
  return out;
}

/** Whether one id a product names is `subject`. */
function productIdMatches(id: string, subject: VexSubject, purls: readonly Purl[]): boolean {
  const purl = parsePurl(id);
  if (purl) {
    // An oci purl's version is the digest, which may be written with or without the escaped colon.
    if (purl.type === "oci" && purl.version !== undefined) {
      return purls.some((have) => have.type === "oci" && have.version !== undefined && bareDigest(have.version) === bareDigest(purl.version!) && purlCovers({ ...purl, version: undefined }, have));
    }
    return purls.some((have) => purlCovers(purl, have));
  }
  const ref = imageReference(id);
  if (!ref || !subject.repository) return false;
  if (normalizeRepository(ref.repository) !== normalizeRepository(subject.repository)) return false;
  if (ref.digest !== undefined && (subject.digest === undefined || bareDigest(ref.digest) !== bareDigest(subject.digest))) return false;
  if (ref.tag !== undefined && !(subject.tags ?? []).includes(ref.tag)) return false;
  return true;
}

/** Whether `product` is `subject`: one of its ids names it, or one of its hashes is its digest. */
function productMatches(product: VexProduct, subject: VexSubject, purls: readonly Purl[]): boolean {
  if (subject.digest && product.hashes.some((h) => bareDigest(h) === bareDigest(subject.digest!))) return true;
  return product.ids.some((id) => productIdMatches(id, subject, purls));
}

/** Whether one id a subcomponent names is the package `finding` is in: by purl, else by name and version. */
function componentIdMatches(id: string, finding: VulnFinding): boolean {
  const want = parsePurl(id);
  const have = finding.purl ? parsePurl(finding.purl) : null;
  if (want && have) return purlCovers(want, have);
  const name = want ? (want.namespace ? `${want.namespace}/${want.name}` : want.name) : id.replace(/@[^@/]*$/, "");
  const version = want ? want.version : /@([^@/]+)$/.exec(id)?.[1];
  if (name.toLowerCase() !== finding.package.toLowerCase()) return false;
  return version === undefined || version === finding.installedVersion;
}

/** Whether `statement` names `finding`'s vulnerability: by any id it gives, against the finding's id and aliases. */
function vulnerabilityMatches(statement: VexStatement, finding: VulnFinding): boolean {
  const want = new Set((statement.ids ?? [statement.cveId]).map((x) => x.toUpperCase()));
  return [finding.cveId, ...(finding.aliases ?? [])].some((id) => want.has(id.toUpperCase()));
}

/** Whether `statement` is about `finding` in `subject`: its vulnerability, a product that is the subject, and, when that product names subcomponents, one that is the finding's package. */
export function statementCovers(statement: VexStatement, finding: VulnFinding, subject: VexSubject): boolean {
  if (!vulnerabilityMatches(statement, finding)) return false;
  const purls = subjectPurls(subject);
  return (statement.products ?? []).some(
    (p) => productMatches(p, subject, purls) && (p.subcomponents.length === 0 || p.subcomponents.some((ids) => ids.some((id) => componentIdMatches(id, finding)))),
  );
}

/** A statement a scoped match can't use, and why. */
export interface InvalidVexStatement {
  statement: VexStatement;
  reason: string;
}

/** Split `statements` into the ones a scoped match can use and the ones it refuses: a statement that names no product. */
export function validateScopedStatements(statements: readonly VexStatement[]): { usable: VexStatement[]; invalid: InvalidVexStatement[] } {
  const usable: VexStatement[] = [];
  const invalid: InvalidVexStatement[] = [];
  for (const s of statements) {
    if ((s.products ?? []).length === 0) invalid.push({ statement: s, reason: "it names no products, so chant can't tell which image or package it is about" });
    else usable.push(s);
  }
  return { usable, invalid };
}

/** The result of a scoped VEX pass: what still gates, what was cleared, and which statements cleared or contested something. */
export interface ScopedVexResult extends VexResult {
  /** The statements that matched a finding in this subject, cleared or contested. */
  used: Set<VexStatement>;
}

/**
 * Filter `findings` of `subject` through `statements`, each applied only
 * where it names: the vulnerability (by id or alias), a product that is the
 * scanned subject, and, where that product names subcomponents, the package
 * the finding is in. Statements without products are left to
 * {@link validateScopedStatements}; here they match nothing. The merge is the
 * conservative one of {@link applyVex}: an `affected` or
 * `under_investigation` statement that covers the finding keeps it gating.
 */
export function applyScopedVex(findings: readonly VulnFinding[], statements: readonly VexStatement[], subject: VexSubject): ScopedVexResult {
  const gating: VulnFinding[] = [];
  const suppressed: SuppressedFinding[] = [];
  const used = new Set<VexStatement>();
  for (const f of findings) {
    const covering = statements.filter((s) => statementCovers(s, f, subject));
    for (const s of covering) used.add(s);
    const contested = covering.some((s) => s.status === "affected" || s.status === "under_investigation");
    const suppressor = contested ? undefined : covering.find((s) => suppresses(s.status));
    if (suppressor) suppressed.push({ finding: f, status: suppressor.status, justification: suppressor.justification, ...(suppressor.ref ? { statement: suppressor.ref } : {}) });
    else gating.push(f);
  }
  return { gating, suppressed, used };
}
