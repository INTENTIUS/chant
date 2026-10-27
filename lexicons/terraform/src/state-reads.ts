/**
 * Variables read from another root's state (#4545, Atmos reads moved from
 * terragucci's `atmos.ts`): an Atmos stack that sets a var with
 * `!terraform.state <component> [<stack>] <output>` plans on the upstream
 * instance's output, which only the job that holds a credential can read.
 *
 * In the `terraform-apply` step a read is `{ var, root, output }`: the var it
 * sets, the `terraform.roots` entry whose state holds the value (its
 * directory and workspace come from that entry), and the output followed by
 * the keys into its value (`.subnets.private` is `["subnets", "private"]`).
 * The step reads each upstream's `output -json` once and passes the values
 * as `-var`, under the step's own `vars`, which win. A read whose upstream
 * has no state, or no such output yet, waits: the root is not planned on a
 * stand-in, and the wave says which upstream to apply first.
 */

/** One var a root reads from another root's state. */
export interface TerraformStateRead {
  /** The variable it sets. */
  var: string;
  /** The `terraform.roots` entry whose state holds the value. */
  root: string;
  /** The output, then the keys into its value. */
  output: string[];
}

/** What filling a root's reads came to. */
export interface FilledStateReads {
  /** The values, by var. Complete only when `waiting` and `errors` are empty. */
  vars: Record<string, unknown>;
  /** Reads whose upstream has no such value yet: the root waits for these upstreams to apply. */
  waiting: Array<{ read: TerraformStateRead; why: string }>;
  /** Upstreams whose state could not be read at all. */
  errors: string[];
}

/** What is wrong with a step's `reads`, empty when nothing is. */
export function stateReadsProblems(reads: unknown): string[] {
  if (reads === undefined) return [];
  if (!Array.isArray(reads)) return ["reads must be a list of { var, root, output }"];
  const problems: string[] = [];
  const vars = new Set<string>();
  for (const [i, r] of reads.entries()) {
    const read = r as Partial<TerraformStateRead> | null;
    if (!read || typeof read !== "object") {
      problems.push(`reads[${i}] must be { var, root, output }`);
      continue;
    }
    if (typeof read.var !== "string" || read.var === "") problems.push(`reads[${i}].var must name a variable`);
    else if (vars.has(read.var)) problems.push(`reads[${i}] sets ${read.var}, which an earlier read sets too`);
    else vars.add(read.var);
    if (typeof read.root !== "string" || read.root === "") problems.push(`reads[${i}].root must name a terraform.roots entry`);
    if (!Array.isArray(read.output) || read.output.length === 0 || !read.output.every((k) => typeof k === "string" && k !== "")) problems.push(`reads[${i}].output must be the output's name, then any keys into its value`);
  }
  return problems;
}

/** The value a read names in its upstream's outputs, or undefined when the outputs do not have it. */
export function readOutputValue(outputs: Record<string, unknown>, output: readonly string[]): { value: unknown } | undefined {
  const [name, ...keys] = output;
  if (name === undefined || !(name in outputs)) return undefined;
  let v: unknown = outputs[name];
  for (const k of keys) {
    if (!v || typeof v !== "object" || Array.isArray(v) || !(k in (v as Record<string, unknown>))) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return { value: v };
}

/**
 * Fill `reads` from each upstream's outputs, read once per upstream through
 * `outputsOf`, which throws when the state cannot be read.
 */
export async function fillStateReads(reads: readonly TerraformStateRead[], outputsOf: (root: string) => Promise<Record<string, unknown>>): Promise<FilledStateReads> {
  const result: FilledStateReads = { vars: {}, waiting: [], errors: [] };
  const cache = new Map<string, Promise<Record<string, unknown>>>();
  for (const read of reads) {
    if (!cache.has(read.root)) cache.set(read.root, outputsOf(read.root));
    let outputs: Record<string, unknown>;
    try {
      outputs = await cache.get(read.root)!;
    } catch (err) {
      result.errors.push(`it reads ${read.var} from ${read.root}, whose state could not be read: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const got = readOutputValue(outputs, read.output);
    if (!got) {
      result.waiting.push({ read, why: Object.keys(outputs).length === 0 ? "has no state yet" : `has no output ${read.output.join(".")} yet` });
      continue;
    }
    result.vars[read.var] = got.value;
  }
  return result;
}

/** Why a root with waiting reads was not planned, naming what to apply first. */
export function waitingReadsReason(waiting: FilledStateReads["waiting"]): string {
  const upstreams = [...new Set(waiting.map((w) => w.read.root))].sort();
  return `not planned: ${waiting.map((w) => `it reads ${w.read.var} from ${w.read.root}, which ${w.why}`).join("; ")}; apply ${upstreams.join(", ")} first`;
}

/**
 * The reads an Atmos instance's edges file lists (`{ reads: [{ var,
 * upstream, output }] }`, as terragucci's `atmos write` leaves beside each
 * instance), with each upstream mapped to its `terraform.roots` entry by
 * `rootOf` (by default the upstream's own path).
 */
export function atmosStateReads(edges: unknown, rootOf: (upstream: string) => string = (u) => u): TerraformStateRead[] {
  const reads = (edges as { reads?: unknown } | null)?.reads;
  if (!Array.isArray(reads)) return [];
  return reads.flatMap((r) => {
    const read = r as { var?: unknown; upstream?: unknown; output?: unknown } | null;
    if (!read || typeof read.var !== "string" || typeof read.upstream !== "string" || !Array.isArray(read.output) || !read.output.every((k) => typeof k === "string")) return [];
    return [{ var: read.var, root: rootOf(read.upstream), output: read.output as string[] }];
  });
}
