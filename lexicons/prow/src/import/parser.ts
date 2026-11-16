/**
 * Prow job config parser for `chant import`: each job becomes one
 * declarable of its kind, with its fields in file order. A presubmit or
 * postsubmit takes its repository key as chant's `repo`, first. The comment
 * lines the file starts with become a JobConfig's header, so building the
 * import writes the file back as it was.
 */

import type { TemplateParser, TemplateIR, ResourceIR } from "@intentius/chant/import/parser";
import { jobsOf, leadingComment, parseJobConfig, type JobType } from "../job-config";

const TYPE: Record<JobType, string> = {
  presubmit: "Prow::Presubmit",
  postsubmit: "Prow::Postsubmit",
  periodic: "Prow::Periodic",
};

/** A job name as a TypeScript identifier: `pull-app-unit` to `pullAppUnit`. */
export function identifierOf(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const id = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join("");
  if (id === "") return "job";
  return /^[0-9]/.test(id) ? `job${id}` : id;
}

const KIND_SUFFIX: Record<JobType, string> = { presubmit: "Presubmit", postsubmit: "Postsubmit", periodic: "Periodic" };

export class ProwJobConfigParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const doc = parseJobConfig(content);
    if (!doc) throw new Error("not a Prow job config: expected presubmits, postsubmits or periodics at the top level");
    const resources: ResourceIR[] = [];
    const header = leadingComment(content);
    if (header !== undefined) resources.push({ logicalId: "jobConfig", type: "Prow::JobConfig", properties: { header } });
    const used = new Set([...resources.map((r) => r.logicalId), "jobs"]);
    for (const j of jobsOf(doc)) {
      const name = typeof j.job.name === "string" ? j.job.name : `${j.type}-${j.index}`;
      let id = identifierOf(name);
      if (used.has(id)) id = `${id}${KIND_SUFFIX[j.type]}`;
      for (let n = 2; used.has(id); n++) id = `${identifierOf(name)}${KIND_SUFFIX[j.type]}${n}`;
      used.add(id);
      resources.push({
        logicalId: id,
        type: TYPE[j.type],
        properties: j.repo !== undefined ? { repo: j.repo, ...j.job } : { ...j.job },
        metadata: { originalName: name },
      });
    }
    return { resources, parameters: [] };
  }
}
