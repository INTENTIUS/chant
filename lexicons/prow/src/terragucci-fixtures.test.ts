/**
 * The job configs terragucci's `runtime: prow` writes today
 * (src/testdata/terragucci/, copied as data) declared with this lexicon's
 * classes, the way terragucci will once it writes its jobs through chant:
 * each builds to the same bytes as the file terragucci wrote.
 *
 * The declarations are written out by hand below, field by field in
 * terragucci's order, so the generated types check every field name. The
 * long values (the scripts, the descriptions and the header) are
 * terragucci's own text, read from the fixture, since the lexicon does not
 * write them.
 */
import { describe, expect, test } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { parseYAML } from "@intentius/chant/yaml";
import { Container, JobConfig, Periodic, Postsubmit, Presubmit } from "./generated/index";
import { emitJobConfig, prowSerializer, type JobConfigDocument } from "./serializer";
import { leadingComment } from "./job-config";
import { fixture, roundTrip } from "./testdata/build";

type Job = { name: string; annotations: { description: string }; spec: { containers: { args: string[] }[] } };

/** terragucci's own text in a fixture: each job's script and description, and the header. */
function textOf(file: string) {
  const text = fixture(`terragucci/${file}.yaml`);
  const doc = parseYAML(text) as unknown as { presubmits: Record<string, Job[]>; postsubmits: Record<string, Job[]>; periodics?: Job[] };
  const find = (type: "presubmits" | "postsubmits" | "periodics", name: string): Job =>
    (type === "periodics" ? doc.periodics! : doc[type]["acme/infra"]).find((j) => j.name === name)!;
  return {
    text,
    header: leadingComment(text)!,
    script: (type: "presubmits" | "postsubmits" | "periodics", name: string) => find(type, name).spec.containers[0].args[0],
    description: (type: "presubmits" | "postsubmits" | "periodics", name: string) => find(type, name).annotations.description,
  };
}

const IMAGE = "ghcr.io/intentius/terragucci-tofu:1";
const TOKEN = [{ name: "GITHUB_TOKEN", valueFrom: { secretKeyRef: { name: "terragucci-github-token", key: "token" } } }];

/** terragucci's jobs for a fixture, as declarables in the order its job config lists them. */
function terragucciJobs(file: "default" | "full" | "config-repo"): Declarable[] {
  const t = textOf(file);
  const full = file === "full";
  const ns = full ? { namespace: "test-pods" } : {};
  const container = (script: string, token: boolean) =>
    new Container({ name: "terragucci", image: IMAGE, command: ["bash", "-c"], args: [script], ...(token ? { env: TOKEN } : {}) });

  const jobs: Declarable[] = [new JobConfig({ header: t.header })];
  jobs.push(
    new Presubmit({
      repo: "acme/infra",
      name: "terragucci-check",
      cluster: "untrusted",
      ...ns,
      always_run: true,
      decorate: true,
      branches: ["^main$"],
      annotations: { description: t.description("presubmits", "terragucci-check") },
      spec: { automountServiceAccountToken: false, containers: [container(t.script("presubmits", "terragucci-check"), false)] },
    }),
  );
  if (full) {
    jobs.push(
      new Presubmit({
        repo: "acme/infra",
        name: "terragucci-plan",
        cluster: "trusted",
        ...ns,
        always_run: true,
        decorate: true,
        branches: ["^main$"],
        trigger: "(?m)^/(test (all|terragucci-plan)|terragucci plan)( .*)?$",
        rerun_command: "/terragucci plan",
        annotations: { description: t.description("presubmits", "terragucci-plan") },
        spec: { serviceAccountName: "tf-plan", containers: [container(t.script("presubmits", "terragucci-plan"), true)] },
      }),
    );
  }
  jobs.push(
    new Postsubmit({
      repo: "acme/infra",
      name: "terragucci-plan",
      cluster: "trusted",
      ...ns,
      decorate: true,
      branches: ["^main$"],
      annotations: { description: t.description("postsubmits", "terragucci-plan") },
      spec: { serviceAccountName: "tf-plan", containers: [container(t.script("postsubmits", "terragucci-plan"), true)] },
    }),
    new Postsubmit({
      repo: "acme/infra",
      name: "terragucci-apply",
      cluster: "trusted",
      ...ns,
      decorate: true,
      decoration_config: { timeout: "3h" },
      max_concurrency: 1,
      branches: ["^main$"],
      annotations: { description: t.description("postsubmits", "terragucci-apply") },
      spec: { serviceAccountName: "tf-apply", containers: [container(t.script("postsubmits", "terragucci-apply"), true)] },
    }),
  );
  if (full) {
    jobs.push(
      new Periodic({
        name: "terragucci-drift",
        cluster: "trusted",
        ...ns,
        cron: "0 6 * * *",
        decorate: true,
        extra_refs: [{ org: "acme", repo: "infra", base_ref: "main", workdir: true }],
        annotations: { description: t.description("periodics", "terragucci-drift") },
        spec: { serviceAccountName: "tf-plan", containers: [container(t.script("periodics", "terragucci-drift"), true)] },
      }),
    );
  }
  return jobs;
}

const FIXTURES = ["default", "full", "config-repo"] as const;

describe("terragucci's Prow job configs, declared in the lexicon", () => {
  for (const file of FIXTURES) {
    test(`${file}.yaml: the declarations build the same bytes`, () => {
      const entities = new Map(terragucciJobs(file).map((d, i) => [`jobs_${i}`, d] as const));
      expect(prowSerializer.serialize(entities)).toBe(fixture(`terragucci/${file}.yaml`));
    });

    test(`${file}.yaml: chant import, then chant build, writes the same bytes`, async () => {
      const text = fixture(`terragucci/${file}.yaml`);
      const { output, errors } = await roundTrip(text);
      expect(errors).toEqual([]);
      expect(output).toBe(text);
    });

    test(`${file}.yaml: emitJobConfig of the plain job data writes the same bytes`, () => {
      const text = fixture(`terragucci/${file}.yaml`);
      const doc = parseYAML(text) as JobConfigDocument;
      expect(emitJobConfig(doc, { header: leadingComment(text)! })).toBe(text);
    });
  }
});
