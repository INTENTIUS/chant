/**
 * The project's own jobs a trigger pipeline starts (#5329).
 *
 * The relay starts the alert agent with a pipeline trigger token, and GitLab
 * runs the whole `.gitlab-ci.yml` in that pipeline. A hand-written job with
 * no `rules`, or with rules that never look at `$CI_PIPELINE_SOURCE`, runs
 * there too, and a deploy job among them would deploy on an alert. The
 * generator reads the project's file and names each such job, with the rule
 * that keeps it out. When the file cannot be read, it says the same as a
 * fixed notice.
 */

import { parseYAMLDocument } from "@intentius/chant/yaml";

/** The rule that keeps a job out of a trigger pipeline, as the first entry of its `rules`. */
export const TRIGGER_GUARD_RULE = `- if: '$CI_PIPELINE_SOURCE == "trigger"'\n  when: never`;

/** The notice the generated file and the generate output carry with an alert agent. */
export const TRIGGER_PIPELINE_NOTICE =
  "the relay starts the alert agent with a pipeline trigger token, and GitLab runs every job of .gitlab-ci.yml that a trigger pipeline reaches. " +
  "Give each job of your own, a deploy job above all, this rule first in its rules, or a $CI_PIPELINE_SOURCE != \"trigger\" condition on each rule:\n" +
  TRIGGER_GUARD_RULE;

/** Top-level keys of a GitLab CI file that are not jobs. */
const NOT_JOBS = new Set(["stages", "variables", "default", "include", "workflow", "image", "services", "before_script", "after_script", "cache", "spec"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a job's rules look at the trigger source: an `if` naming `$CI_PIPELINE_SOURCE` and `trigger`. */
function guarded(rules: unknown): boolean {
  if (!Array.isArray(rules)) return false;
  return rules.some((r) => isObject(r) && typeof r.if === "string" && /\$CI_PIPELINE_SOURCE\b/.test(r.if) && /["']trigger["']/.test(r.if));
}

/** Whether an `except:` keeps the job out of trigger pipelines. */
function exceptsTriggers(except: unknown): boolean {
  const refs = Array.isArray(except) ? except : isObject(except) && Array.isArray(except.refs) ? except.refs : [];
  return refs.includes("triggers");
}

/**
 * The warnings for a project's `.gitlab-ci.yml`: one per job a trigger
 * pipeline would start (`skip` names the jobs chant generates), and one when
 * the file includes others this check cannot see. `text` undefined: the
 * fixed notice.
 */
export function triggerPipelineWarnings(ci: { path: string; text?: string } | undefined, skip: ReadonlySet<string> = new Set(), ownFiles: readonly string[] = []): string[] {
  if (!ci || ci.text === undefined) return [`${ci?.path ?? ".gitlab-ci.yml"} could not be read, so its jobs were not checked: ${TRIGGER_PIPELINE_NOTICE}`];
  let doc: unknown;
  try {
    doc = parseYAMLDocument(ci.text);
  } catch (e) {
    return [`${ci.path} could not be parsed (${(e as Error).message}), so its jobs were not checked: ${TRIGGER_PIPELINE_NOTICE}`];
  }
  if (!isObject(doc)) return [];
  const out: string[] = [];
  const entries = doc;
  // A job's rules may come from the templates it extends; the last one that sets them wins, as in GitLab.
  const inherited = (job: Record<string, unknown>, seen = new Set<string>()): Record<string, unknown> => {
    if ("rules" in job || "except" in job) return job;
    const ext = typeof job.extends === "string" ? [job.extends] : Array.isArray(job.extends) ? job.extends.filter((x): x is string => typeof x === "string") : [];
    for (const t of [...ext].reverse()) {
      const base = entries[t];
      if (seen.has(t) || !isObject(base)) continue;
      seen.add(t);
      const got = inherited(base, seen);
      if ("rules" in got || "except" in got) return got;
    }
    return job;
  };
  for (const [name, own] of Object.entries(doc)) {
    if (name.startsWith(".") || NOT_JOBS.has(name) || skip.has(name) || !isObject(own)) continue;
    const job = inherited(own);
    if ("rules" in job) {
      if (guarded(job.rules)) continue;
      out.push(`${ci.path}: job ${name} has rules with no condition on a trigger pipeline ($CI_PIPELINE_SOURCE == "trigger"), so the alert agent's trigger pipeline starts it. Put this first in its rules:\n${TRIGGER_GUARD_RULE}`);
      continue;
    }
    if ("except" in job && exceptsTriggers(job.except)) continue;
    out.push(`${ci.path}: job ${name} has no rules, so the alert agent's trigger pipeline starts it. Give it rules that begin with:\n${TRIGGER_GUARD_RULE}`);
  }
  const included = (Array.isArray(doc.include) ? doc.include : doc.include === undefined ? [] : [doc.include]).map((i) => (typeof i === "string" ? i : isObject(i) && typeof i.local === "string" ? i.local : "(remote)"));
  // chant's own generated file is the one this check knows; any other include is unseen.
  if (included.some((i) => !ownFiles.some((f) => i === f || i.endsWith(`/${f}`)))) out.push(`${ci.path} includes other files, whose jobs were not checked: ${TRIGGER_PIPELINE_NOTICE}`);
  return out;
}
