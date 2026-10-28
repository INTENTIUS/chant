/**
 * Consumers joined across a control repo (#4600, terragucci#1289 bundle B):
 * each project the control repo lists keeps a `consumers.json` beside its
 * catalog, naming the release versions its roots pin and where, and this
 * joins them into one consumer list per version, every consumer named by
 * the project it sits in. The result is the `consumers` input of
 * `buildReleaseCatalog` (../lifecycle/release-catalog.ts, #4595), so the
 * catalog page of a version lists its consumers in every project.
 *
 * `consumers.json` is the catalog's own consumer input, written per project:
 *
 *   { "contract": 1, "consumers": [ { "component": "vpc", "version": "1.2.0", "consumers": [ { "root": "live/prod", "file": "live/prod/main.tf", "address": "module.vpc" } ] } ] }
 *
 * A bare array of the same entries is read too. A product's scan fills it
 * (the terraform lexicon's `moduleConsumers`, #4599, for terragucci) and the
 * product decides where it is kept. Where it is read from is the product's
 * too: {@link readControlConsumers} takes the control repo's entries and a
 * reader for one project's file, so it reads neither git nor the network
 * itself. Core carries no engine word.
 */

import type { CatalogConsumer, CatalogConsumersInput } from "../lifecycle/release-catalog";
import type { ControlEntry } from "./records";

/** The file each project keeps its consumers in. */
export const CONSUMERS_FILE = "consumers.json";
/** The contract version of {@link ConsumersDocument}. */
export const CONSUMERS_CONTRACT = 1;

/** One project's `consumers.json`. */
export interface ConsumersDocument {
  contract: typeof CONSUMERS_CONTRACT;
  consumers: CatalogConsumersInput[];
}

/** One project's consumers as the join is given them. */
export interface ProjectConsumers {
  /** The project's key, `<host>/<owner>/<name>`, as the control repo's entry names it. */
  project: string;
  /** Its `consumers.json`: the text, or the parsed document. */
  document: string | unknown;
}

/** What a join gives: one entry per version, and each project file it could not read. */
export interface JoinedConsumers {
  consumers: CatalogConsumersInput[];
  /** One line per problem, each naming the project. */
  problems: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optionalString = (v: unknown) => v === undefined || typeof v === "string";

/** The problems with one consumer, or []. */
function consumerProblems(c: unknown, at: string): string[] {
  if (!isObject(c)) return [`${at}: not an object`];
  const out: string[] = [];
  if (typeof c.root !== "string" || c.root === "") out.push(`${at}.root: a non-empty string`);
  for (const k of ["repo", "file", "address"] as const) if (!optionalString(c[k])) out.push(`${at}.${k}: a string when set`);
  return out;
}

/**
 * A `consumers.json` read and checked: its entries, or the problems with it.
 * Each entry names a component and a version or digest, and each consumer a root.
 */
export function parseConsumersDocument(document: string | unknown): { consumers: CatalogConsumersInput[]; problems: string[] } {
  let doc: unknown = document;
  if (typeof document === "string") {
    try {
      doc = JSON.parse(document);
    } catch (e) {
      return { consumers: [], problems: [`not JSON: ${(e as Error).message}`] };
    }
  }
  let list: unknown;
  if (Array.isArray(doc)) list = doc;
  else if (isObject(doc)) {
    if (doc.contract !== CONSUMERS_CONTRACT) return { consumers: [], problems: [`contract ${JSON.stringify(doc.contract)}: this chant reads contract ${CONSUMERS_CONTRACT}`] };
    list = doc.consumers;
  }
  if (!Array.isArray(list)) return { consumers: [], problems: ["no consumers list"] };
  const consumers: CatalogConsumersInput[] = [];
  const problems: string[] = [];
  list.forEach((e, i) => {
    const at = `consumers[${i}]`;
    if (!isObject(e)) return void problems.push(`${at}: not an object`);
    const own: string[] = [];
    if (typeof e.component !== "string" || e.component === "") own.push(`${at}.component: a non-empty string`);
    if (!optionalString(e.version) || !optionalString(e.digest)) own.push(`${at}: version and digest are strings when set`);
    if (e.version === undefined && e.digest === undefined) own.push(`${at}: names neither a version nor a digest`);
    if (!Array.isArray(e.consumers)) own.push(`${at}.consumers: a list`);
    else e.consumers.forEach((c, j) => own.push(...consumerProblems(c, `${at}.consumers[${j}]`)));
    if (own.length > 0) return void problems.push(...own);
    consumers.push({
      component: e.component as string,
      ...(e.version !== undefined ? { version: e.version as string } : {}),
      ...(e.digest !== undefined ? { digest: e.digest as string } : {}),
      consumers: (e.consumers as CatalogConsumer[]).map((c) => ({ ...c })),
    });
  });
  return { consumers, problems };
}

/** A `consumers.json` for one project's consumers, as a product writes it. Entries and consumers are sorted, so a rerun writes the same bytes. */
export function consumersDocument(consumers: readonly CatalogConsumersInput[]): string {
  const doc: ConsumersDocument = {
    contract: CONSUMERS_CONTRACT,
    consumers: [...consumers]
      .map((c) => ({ ...c, consumers: [...c.consumers].sort((a, b) => consumerKey(a).localeCompare(consumerKey(b))) }))
      .sort((a, b) => versionKey(a).localeCompare(versionKey(b))),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const consumerKey = (c: CatalogConsumer): string => [c.repo ?? "", c.root, c.file ?? "", c.address ?? ""].join("\u0000");
/** One version: its component and version, else its digest. */
const versionKey = (c: Pick<CatalogConsumersInput, "component" | "version" | "digest">): string => `${c.component}\u0000${c.version !== undefined ? `v:${c.version}` : `d:${c.digest}`}`;

/**
 * One consumer list per version across the projects: every project's
 * entries for the same component and version (or, with no version, the same
 * digest) merged into one, each consumer's `repo` set to the project it sits
 * in unless the file named one, duplicates dropped, sorted by version then
 * consumer. A project whose file has problems adds what it could read and
 * names each problem.
 */
export function joinControlConsumers(projects: readonly ProjectConsumers[]): JoinedConsumers {
  const byVersion = new Map<string, { input: CatalogConsumersInput; seen: Set<string> }>();
  const problems: string[] = [];
  for (const p of [...projects].sort((a, b) => a.project.localeCompare(b.project))) {
    const read = parseConsumersDocument(p.document);
    for (const problem of read.problems) problems.push(`${p.project}: ${CONSUMERS_FILE}: ${problem}`);
    for (const entry of read.consumers) {
      const key = versionKey(entry);
      let at = byVersion.get(key);
      if (!at) {
        at = {
          input: { component: entry.component, ...(entry.version !== undefined ? { version: entry.version } : {}), ...(entry.digest !== undefined ? { digest: entry.digest } : {}), consumers: [] },
          seen: new Set(),
        };
        byVersion.set(key, at);
      }
      if (at.input.digest === undefined && entry.digest !== undefined) at.input.digest = entry.digest;
      for (const c of entry.consumers) {
        const named: CatalogConsumer = { ...c, repo: c.repo ?? p.project };
        const k = consumerKey(named);
        if (at.seen.has(k)) continue;
        at.seen.add(k);
        at.input.consumers.push(named);
      }
    }
  }
  const consumers = [...byVersion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => ({ ...v.input, consumers: v.input.consumers.sort((a, b) => consumerKey(a).localeCompare(consumerKey(b))) }));
  return { consumers, problems };
}

/** Reads one project's `consumers.json`: its text, or null when the project keeps none. */
export type ProjectConsumersReader = (project: string, entry: ControlEntry) => Promise<string | null>;

/** What {@link readControlConsumers} gives: the join, and the projects that keep no file. */
export interface ControlConsumers extends JoinedConsumers {
  /** Projects the control repo lists whose reader found no `consumers.json`. */
  missing: string[];
}

/**
 * The consumers of every project the control repo lists, joined. `entries`
 * are the control repo's current entries (`readControlEntries`, ./records.ts);
 * the defaults entry is passed over. A reader that throws for a project
 * names it in `problems` and the join goes on with the rest.
 */
export async function readControlConsumers(entries: readonly ControlEntry[], read: ProjectConsumersReader): Promise<ControlConsumers> {
  const projects: ProjectConsumers[] = [];
  const missing: string[] = [];
  const problems: string[] = [];
  for (const e of [...entries].filter((x) => x.entry === "project" && x.project).sort((a, b) => a.project!.localeCompare(b.project!))) {
    let text: string | null;
    try {
      text = await read(e.project!, e);
    } catch (err) {
      problems.push(`${e.project}: ${CONSUMERS_FILE} could not be read: ${(err as Error).message}`);
      continue;
    }
    if (text === null) missing.push(e.project!);
    else projects.push({ project: e.project!, document: text });
  }
  const joined = joinControlConsumers(projects);
  return { consumers: joined.consumers, problems: [...problems, ...joined.problems], missing };
}
