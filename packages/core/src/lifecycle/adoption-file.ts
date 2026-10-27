/**
 * The adoption file, `adopt: "v1"` (chant#4536; ruled on
 * INTENTIUS/choudoufu#2284 Q1, 2026-10-26).
 *
 * One input for the three engines that adopt an indexed resource: choudoufu
 * `live-import`, plunge `stack adopt` and chant's CloudFormation import. It
 * names one index version (scope key, version name and digest) and the nodes
 * to adopt from it. Each selected node carries the engine's address for it
 * and, where the inventory type joins to more than one engine type, the
 * engine type.
 *
 * The index proposes and the live read decides: an engine reads each object
 * again before it writes anything. The file only says which object and
 * where. An engine refuses a file whose index digest does not match the
 * version it loads, and a node that version does not hold
 * ({@link validateAdoptionFile}).
 *
 * Its JSON Schema is `#/$defs/AdoptionFile` in ../graph-schema/graph.schema.json,
 * generated from these types; the Go engines read the JSON and test against
 * ../graph-schema/fixtures/adopt.json.
 *
 * `chant import --index ... --adopt-out <file>` writes one from the import
 * report ({@link adoptionFileFromImportReport}).
 */
import { indexVersionName, type IndexDocument } from "./index-document";
import type { IndexImportReport } from "./index-import";

/** The first chant that writes or reads an adoption file. */
export const ADOPTION_FILE_FLOOR = "0.124.54";

/** The index version an adoption file reads from. */
export interface AdoptionIndexRef {
  /** The version's `stamp.scopeKey`: `cloud/<substrate>/<scopeId>/<scope digest>`. */
  scopeKey: string;
  /** The version's file name under the scope key: `<observedAt>-<digest12>.json`. */
  version: string;
  /** The version's `stamp.digest`, sha256 hex. A `sha256:` prefix is accepted and ignored. */
  digest: string;
}

/** One node to adopt. */
export interface AdoptionSelection {
  /** The index node id: `<substrate>/<scopeId>/<location>/<listedType>/<nativeId>`. */
  node: string;
  /**
   * The engine's address for the object: a Terraform address for choudoufu,
   * a URN name and parent for plunge, an entity (logical) name for chant.
   */
  as: string;
  /**
   * The engine's type (`aws_lb`, `aws:s3/bucket:Bucket`, `AWS::S3::Bucket`).
   * Left out only when the node's listed type joins to exactly one engine
   * type; an engine refuses an ambiguous join without it, naming every
   * candidate.
   */
  type?: string;
}

/** An adoption file (`adopt: "v1"`): one index version and the nodes to adopt from it. */
export interface AdoptionFile {
  adopt: "v1";
  index: AdoptionIndexRef;
  select: AdoptionSelection[];
}

const bareDigest = (d: string): string => d.replace(/^sha256:/, "");

/** Refusals of an adoption file on its own: shape, version name, duplicate nodes and addresses. */
export function adoptionFileProblems(file: AdoptionFile): string[] {
  const problems: string[] = [];
  if (file.adopt !== "v1") problems.push(`adoption file version "${String(file.adopt)}" is not v1`);
  const ix = file.index;
  if (!ix || typeof ix.scopeKey !== "string" || ix.scopeKey === "") problems.push("index.scopeKey is missing");
  if (!ix || typeof ix.digest !== "string" || !/^[0-9a-f]{12,}$/.test(bareDigest(ix.digest))) {
    problems.push(`index.digest "${String(ix?.digest)}" is not sha256 hex`);
  } else if (typeof ix.version !== "string" || !/^\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/.test(ix.version)) {
    problems.push(`index.version "${String(ix?.version)}" is not an index version name (<observedAt>-<digest12>.json)`);
  } else if (!ix.version.endsWith(`-${bareDigest(ix.digest).slice(0, 12)}.json`)) {
    problems.push(`index.version ${ix.version} does not name the digest ${bareDigest(ix.digest).slice(0, 12)}`);
  }
  if (!Array.isArray(file.select) || file.select.length === 0) {
    problems.push("select names no node");
    return problems;
  }
  const nodes = new Set<string>();
  const addresses = new Set<string>();
  for (const s of file.select) {
    if (!s.node) problems.push("a selection has no node");
    if (!s.as) problems.push(`${s.node}: no engine address (as)`);
    if (s.node && nodes.has(s.node)) problems.push(`${s.node} is selected twice`);
    if (s.as && addresses.has(s.as)) problems.push(`two nodes are adopted as ${s.as}`);
    nodes.add(s.node);
    addresses.add(s.as);
  }
  return problems;
}

/**
 * Refusals of an adoption file against the index version it is read with:
 * a scope key, version or digest that is not that version's, and a selected
 * node the version does not hold. Empty when the file can be used.
 */
export function adoptionFileProblemsAgainst(file: AdoptionFile, doc: IndexDocument): string[] {
  const problems = adoptionFileProblems(file);
  const { stamp } = doc;
  if (file.index.scopeKey !== stamp.scopeKey) problems.push(`index.scopeKey ${file.index.scopeKey} is not the version's ${stamp.scopeKey}`);
  if (bareDigest(file.index.digest) !== bareDigest(stamp.digest)) problems.push(`index.digest does not match the version's digest ${bareDigest(stamp.digest).slice(0, 12)}`);
  const version = indexVersionName(stamp.observedAt, stamp.digest);
  if (file.index.version !== version) problems.push(`index.version ${file.index.version} is not the version read (${version})`);
  const held = new Set(doc.graph.nodes.map((n) => n.id));
  for (const s of file.select ?? []) {
    if (s.node && !held.has(s.node)) problems.push(`${s.node} is not in index version ${version}`);
  }
  return problems;
}

/** Throw on the first refusal of {@link adoptionFileProblemsAgainst}, or of {@link adoptionFileProblems} with no document. */
export function validateAdoptionFile(file: AdoptionFile, doc?: IndexDocument): void {
  const problems = doc ? adoptionFileProblemsAgainst(file, doc) : adoptionFileProblems(file);
  if (problems.length > 0) throw new Error(`adoption file refused: ${problems.join("; ")}`);
}

/**
 * The adoption file for what an index import wrote: every `imported`
 * resource, adopted as its logical id, with its lexicon kind as the type
 * (`AWS::S3::Bucket`). Declared and unsupported resources are left out. Refuses a report
 * read from more than one index version, since an adoption file names one.
 */
export function adoptionFileFromImportReport(report: IndexImportReport): AdoptionFile {
  if (report.index.length !== 1) {
    throw new Error(
      `an adoption file names one index version; this import read ${report.index.length} (${report.index.map((i) => i.scopeKey).join(", ")})`,
    );
  }
  const [ix] = report.index;
  const select: AdoptionSelection[] = report.resources
    .filter((r) => r.status === "imported" && r.logicalId !== undefined)
    .map((r) => ({ node: r.node, as: r.logicalId!, ...(r.kind ? { type: r.kind } : {}) }))
    .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  if (select.length === 0) throw new Error("the import wrote no resource, so there is nothing to adopt");
  const file: AdoptionFile = {
    adopt: "v1",
    index: { scopeKey: ix.scopeKey, version: indexVersionName(ix.observedAt, ix.digest), digest: bareDigest(ix.digest) },
    select,
  };
  validateAdoptionFile(file);
  return file;
}

/** An adoption file as written: two-space JSON and a final newline. */
export function adoptionFileJson(file: AdoptionFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}
