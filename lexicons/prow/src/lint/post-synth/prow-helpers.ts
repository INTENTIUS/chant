/**
 * What the PROW post-synth checks share: the built job configs of a build,
 * and what in a job's pod spec reads a credential.
 */

import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { jobsOf, parseJobConfig, type LocatedJob } from "../../job-config";

/** Each job config the build wrote: the prow output, and any other output that is one. */
export function builtJobConfigs(ctx: PostSynthContext): Array<{ source: string; jobs: LocatedJob[] }> {
  const out: Array<{ source: string; jobs: LocatedJob[] }> = [];
  for (const [name, output] of ctx.outputs) {
    const texts: Array<[string, string]> =
      typeof output === "string" ? [[name, output]] : [[name, (output as SerializerResult).primary], ...Object.entries((output as SerializerResult).files ?? {})];
    for (const [source, text] of texts) {
      if (!text) continue;
      const doc = parseJobConfig(text);
      if (doc) out.push({ source, jobs: jobsOf(doc) });
    }
  }
  return out;
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isMap) : []);

/** The job's name, for a message. */
export function nameOf(j: LocatedJob): string {
  return typeof j.job.name === "string" ? j.job.name : `(unnamed ${j.type})`;
}

/** The build cluster a job runs on: its `cluster`, or Prow's `default`. */
export function clusterOf(j: LocatedJob): string {
  return typeof j.job.cluster === "string" && j.job.cluster !== "" ? j.job.cluster : "default";
}

/**
 * The credentials a job's pod reads from Secrets: a secret volume (plain or
 * projected), an environment variable from a Secret's key, and a container's
 * envFrom of a whole Secret, each as a short description.
 */
export function secretMounts(job: Record<string, unknown>): string[] {
  const spec = isMap(job.spec) ? job.spec : {};
  const found: string[] = [];
  for (const v of list(spec.volumes)) {
    if (isMap(v.secret)) found.push(`volume ${String(v.name)} from Secret ${String(v.secret.secretName)}`);
    if (isMap(v.projected)) {
      for (const s of list(v.projected.sources)) if (isMap(s.secret)) found.push(`volume ${String(v.name)} projecting Secret ${String(s.secret.name)}`);
    }
  }
  for (const c of [...list(spec.initContainers), ...list(spec.containers)]) {
    for (const e of list(c.env)) {
      const from = isMap(e.valueFrom) ? e.valueFrom : undefined;
      if (from && isMap(from.secretKeyRef)) found.push(`${String(c.name)}'s ${String(e.name)} from Secret ${String(from.secretKeyRef.name)}`);
    }
    for (const e of list(c.envFrom)) if (isMap(e.secretRef)) found.push(`${String(c.name)}'s environment from Secret ${String(e.secretRef.name)}`);
  }
  return found;
}

/** The pod's service account, when the job names one: an identity the cluster may bind to a cloud account. */
export function serviceAccountOf(job: Record<string, unknown>): string | undefined {
  const spec = isMap(job.spec) ? job.spec : {};
  const sa = spec.serviceAccountName ?? spec.serviceAccount;
  return typeof sa === "string" && sa !== "" && sa !== "default" ? sa : undefined;
}
