/**
 * Prow job config serializer.
 *
 * Writes the one file Prow loads as job config (a file under its
 * `job_config_path`): `presubmits` and `postsubmits` keyed by repository,
 * then `periodics`, each job a map of Prow's own fields. A presubmit or
 * postsubmit names its repository with chant's `repo` field, which the job
 * config uses as the key and the job does not carry. Repositories and jobs
 * come out in the order they were declared, and so do a job's fields, so a
 * declaration written in the order of an existing file builds that file's
 * text. A job's `name` defaults to the name it is exported as.
 *
 * `JobConfig`'s `header` is written as comment lines above the jobs. The
 * YAML is core's emitter (`emitYAML`), the same one a product that writes
 * Prow jobs itself uses, so the text is the same byte for byte.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult, SerializeContext } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { emitYAML } from "@intentius/chant/yaml";

type Job = Record<string, unknown>;

/** The job config as Prow reads it: plain data. */
export interface JobConfigDocument {
  presubmits?: Record<string, Job[]>;
  postsubmits?: Record<string, Job[]>;
  periodics?: Job[];
}

export const PROW_TYPES = {
  presubmit: "Prow::Presubmit",
  postsubmit: "Prow::Postsubmit",
  periodic: "Prow::Periodic",
  jobConfig: "Prow::JobConfig",
} as const;

const visitor: SerializerVisitor = {
  attrRef: (name) => name,
  resourceRef: (name) => name,
  propertyDeclarable: (entity, walk) => {
    if (!isResourceDeclarable(entity) || typeof entity.props !== "object" || entity.props === null) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entity.props as Record<string, unknown>)) {
      if (value !== undefined) out[key] = walk(value);
    }
    return out;
  },
};

/** Comment lines from a header: each line kept as written, `# ` put before one that is not a comment. */
function commentLines(header: string): string {
  return header
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => (l.startsWith("#") ? l : l === "" ? "#" : `# ${l}`))
    .join("\n");
}

/**
 * The job config text: the header's comment lines, a blank line, then the
 * jobs. Without a header the text starts with the jobs. A key with no jobs is
 * left out.
 */
export function emitJobConfig(doc: JobConfigDocument, options: { header?: string } = {}): string {
  const body: Record<string, unknown> = {};
  if (doc.presubmits && Object.keys(doc.presubmits).length > 0) body.presubmits = doc.presubmits;
  if (doc.postsubmits && Object.keys(doc.postsubmits).length > 0) body.postsubmits = doc.postsubmits;
  if (doc.periodics && doc.periodics.length > 0) body.periodics = doc.periodics;
  const yaml = Object.keys(body).length > 0 ? emitYAML(body, 0).trimEnd() : "{}";
  const jobs = yaml.replace(/^\n/, "");
  return options.header !== undefined ? `${commentLines(options.header)}\n\n${jobs}\n` : `${jobs}\n`;
}

function jobOf(exportName: string, entity: Declarable, entityNames: Map<Declarable, string>): { repo?: string; job: Job } {
  const raw = (isResourceDeclarable(entity) ? entity.props : {}) as Record<string, unknown>;
  const props = (walkValue(raw, entityNames, visitor) ?? {}) as Record<string, unknown>;
  const job: Job = {};
  if (props.name === undefined) job.name = exportName;
  let repo: string | undefined;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === "repo") {
      repo = String(value);
      continue;
    }
    job[key] = value;
  }
  return { repo, job };
}

/** The job config of a build's entities, as data, and the header. */
export function jobConfigOf(entities: Map<string, Declarable>): { doc: JobConfigDocument; header?: string; problems: string[] } {
  const entityNames = new Map<Declarable, string>();
  for (const [name, entity] of entities) entityNames.set(entity, name);
  const presubmits: Record<string, Job[]> = {};
  const postsubmits: Record<string, Job[]> = {};
  const periodics: Job[] = [];
  const problems: string[] = [];
  let header: string | undefined;
  for (const [name, entity] of entities) {
    switch (entity.entityType) {
      case PROW_TYPES.presubmit:
      case PROW_TYPES.postsubmit: {
        const { repo, job } = jobOf(name, entity, entityNames);
        if (!repo) {
          problems.push(`${name}: a ${entity.entityType === PROW_TYPES.presubmit ? "presubmit" : "postsubmit"} names its repository with repo, as owner/name`);
          continue;
        }
        const into = entity.entityType === PROW_TYPES.presubmit ? presubmits : postsubmits;
        (into[repo] ??= []).push(job);
        break;
      }
      case PROW_TYPES.periodic:
        periodics.push(jobOf(name, entity, entityNames).job);
        break;
      case PROW_TYPES.jobConfig: {
        const props = (isResourceDeclarable(entity) ? entity.props : {}) as { header?: string };
        if (header !== undefined) problems.push(`${name}: a build has one JobConfig, and another already set the header`);
        else if (props.header !== undefined) header = props.header;
        break;
      }
    }
  }
  return { doc: { presubmits, postsubmits, periodics }, header, problems };
}

export const prowSerializer: Serializer = {
  name: "prow",
  rulePrefix: "PROW",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[], _context?: SerializeContext): string | SerializerResult {
    const { doc, header, problems } = jobConfigOf(entities);
    if (problems.length > 0) throw new Error(`prow: ${problems.join("; ")}`);
    return emitJobConfig(doc, header !== undefined ? { header } : {});
  },
};
