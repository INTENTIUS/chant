/**
 * `chant run --components <name> --env <env> --adopt <adoption-file>`
 * (#4537): adopt the resources an adoption file names into the component's
 * stack, through the lexicon's deploy step.
 *
 * Core reads the adoption file and the index version it names, refuses a file
 * that does not match that version, and hands the step a
 * {@link DeployAdoption} on `DeployContext.adoption`. The step (the aws
 * lexicon's `cfn-deploy`, lexicons/aws/src/components/cfn-adopt.ts) plans and
 * runs the adoption. Every change set it makes goes through
 * {@link DeployAdoption.review} before it executes: that review is the gate
 * (INTENTIUS/choudoufu#2284 Q3, "each engine's gate"). It prints the change
 * set and each marker write as tags only, then asks. `--yes` answers yes for
 * a run with no terminal; without `--yes` and without a terminal, the review
 * declines, so the run shows the IMPORT change set, deletes it and changes
 * nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NEXT_RELEASE } from "../release-floors";
import type { ChangeSetEntry } from "../change-set";
import { adoptionFileProblems, adoptionFileProblemsAgainst, type AdoptionFile } from "../lifecycle/adoption-file";
import type { IndexDocument } from "../lifecycle/index-document";

/** The first chant whose `run --components` takes `--adopt`. */
export const DEPLOY_ADOPT_FLOOR = NEXT_RELEASE;

/** One change set the adoption asks to execute. */
export interface AdoptionReviewRequest {
  /** The member (stack) the change set is for. */
  member: string;
  /** `import`: the IMPORT change set. `markers`: the UPDATE that writes chant's marker tags. */
  step: "import" | "markers";
  /** The change set's name, as the backend knows it. */
  changeSet: string;
  /** The change set's changes, as change-set entries. */
  entries: ChangeSetEntry[];
  /** What it writes, one line each: an import per resource, or a marker write as tags only. */
  lines: string[];
}

/** The gate: show the change set and answer whether to execute it. */
export type AdoptionReview = (request: AdoptionReviewRequest) => Promise<boolean>;

/** How an adoption ended, as the step reports it. */
export interface DeployAdoptionOutcome {
  member: string;
  status: "adopted" | "refused" | "declined" | "failed";
  /** Where it stopped: `plan` before any change set, `import` or `markers`. Absent when adopted. */
  step?: "plan" | "import" | "markers";
  /** What to print, one line each: what was adopted, every refusal, and what to do next. */
  lines: string[];
}

/** What `--adopt <file>` hands the deploy step on `DeployContext.adoption`. */
export interface DeployAdoption {
  /** The adoption file's path, as given. */
  file: string;
  adoption: AdoptionFile;
  /** The index version the file names, read from the store or a file. */
  index: IndexDocument;
  review: AdoptionReview;
  /**
   * Set by the step that takes the adoption, so a second step refuses it and
   * the command can tell when no step took it.
   */
  outcome?: DeployAdoptionOutcome;
}

/** The index version a file names, in the ref grammar `chant search --index` reads: `<scopeKey>@<version>`. */
export function adoptionIndexRef(file: AdoptionFile): string {
  return `${file.index.scopeKey}@${file.index.version}`;
}

/**
 * Read an adoption file and the index version it names. `indexAt` overrides
 * where the version is read from (an index document file, as `chant import
 * --index <file>` takes); otherwise it is the project's snapshot store.
 * Throws with every refusal named.
 */
export async function loadDeployAdoption(
  file: string,
  opts: { cwd: string; indexAt?: string; loadIndex?: (ref: string, cwd: string) => Promise<IndexDocument[]> },
): Promise<Omit<DeployAdoption, "review">> {
  const path = resolve(opts.cwd, file);
  if (!existsSync(path)) throw new Error(`--adopt ${file}: no such file`);
  let adoption: AdoptionFile;
  try {
    adoption = JSON.parse(readFileSync(path, "utf-8")) as AdoptionFile;
  } catch (err) {
    throw new Error(`--adopt ${file}: not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!adoption || typeof adoption !== "object") throw new Error(`--adopt ${file}: not an adoption file`);
  const own = adoptionFileProblems(adoption);
  if (own.length > 0) throw new Error(`--adopt ${file}: adoption file refused: ${own.join("; ")}`);
  const load = opts.loadIndex ?? (async (ref: string, cwd: string) => (await import("../cli/commands/import-index")).loadIndexDocuments(ref, cwd));
  const ref = opts.indexAt ?? adoptionIndexRef(adoption);
  let docs: IndexDocument[];
  try {
    docs = await load(ref, opts.cwd);
  } catch (err) {
    throw new Error(`--adopt ${file}: could not read index version ${adoptionIndexRef(adoption)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const index = docs.find((d) => d.stamp?.scopeKey === adoption.index.scopeKey) ?? docs[0];
  if (!index) throw new Error(`--adopt ${file}: ${ref} holds no index document`);
  const against = adoptionFileProblemsAgainst(adoption, index);
  if (against.length > 0) throw new Error(`--adopt ${file}: adoption file refused: ${against.join("; ")}`);
  return { file, adoption, index };
}

/** A change set as review text: a heading, each change, then what it writes. */
export function renderAdoptionReview(request: AdoptionReviewRequest): string[] {
  const heading =
    request.step === "import"
      ? `IMPORT change set ${request.changeSet} for ${request.member}: brings existing resources under the stack, without chant's markers`
      : `Marker change set ${request.changeSet} for ${request.member}: writes chant's marker tags on the imported resources, tags only`;
  const changes = request.entries.map((e) => `  ${e.importing ? "import" : e.action} ${e.address} (${e.type})${e.attributes.length > 0 ? `: ${e.attributes.map((a) => a.path).join(", ")}` : ""}`);
  return [heading, ...(changes.length > 0 ? changes : ["  (no changes listed)"]), ...request.lines.map((l) => `  ${l}`)];
}

/**
 * The review `run --components --adopt` uses: print the change set, then
 * answer. `yes` (`--yes`) approves. Otherwise a terminal is asked
 * (`ask`), and with no terminal the review declines and says how to approve.
 */
export function adoptionReview(opts: {
  yes: boolean;
  write: (line: string) => void;
  ask?: (question: string) => Promise<boolean>;
}): AdoptionReview {
  return async (request) => {
    for (const line of renderAdoptionReview(request)) opts.write(line);
    if (opts.yes) {
      opts.write(`  approved by --yes; executing ${request.changeSet}`);
      return true;
    }
    if (opts.ask) return opts.ask(`Execute ${request.step === "import" ? "the IMPORT" : "the marker"} change set ${request.changeSet}? [y/N] `);
    opts.write(`  not executed: no terminal to answer and no --yes. Read the change set above, then run again with --yes to execute it.`);
    return false;
  };
}
