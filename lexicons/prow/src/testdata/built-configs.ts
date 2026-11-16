/**
 * The job configs the loader tests build: one chant builds from declarations
 * (every kind, and the fields terragucci's jobs use), and terragucci's full
 * job config imported and built.
 */
import { expect } from "vitest";
import { buildSources, fixture, roundTrip } from "./build";

/** A job config chant builds from declarations: every kind, and the fields terragucci's jobs use. */
export const AUTHORED = `import { Presubmit, Postsubmit, Periodic } from "@intentius/chant-lexicon-prow";

const container = { name: "test", image: "golang:1.26", command: ["go"], args: ["test", "./..."] };

export const jobs = [
  new Presubmit({
    repo: "acme/app",
    name: "pull-app-unit",
    cluster: "untrusted",
    optional: false,
    decorate: true,
    skip_if_only_changed: "^docs/",
    branches: ["^main$"],
    context: "ci/unit",
    max_concurrency: 4,
    annotations: { description: "unit tests" },
    spec: { automountServiceAccountToken: false, containers: [container] },
  }),
  new Presubmit({
    repo: "acme/app",
    name: "pull-app-lint",
    cluster: "untrusted",
    run_if_changed: "\\\\.go$",
    decorate: true,
    trigger: "(?m)^/lint( .*)?$",
    rerun_command: "/lint",
    spec: { containers: [{ ...container, args: ["vet", "./..."] }] },
  }),
  new Postsubmit({
    repo: "acme/app",
    name: "post-app-publish",
    cluster: "trusted",
    decorate: true,
    decoration_config: { timeout: "1h" },
    max_concurrency: 1,
    branches: ["^main$"],
    reporter_config: { slack: { channel: "builds" } },
    spec: { serviceAccountName: "publisher", containers: [{ ...container, args: ["build", "./..."] }] },
  }),
  new Periodic({
    name: "periodic-app-e2e",
    cluster: "trusted",
    interval: "24h",
    decorate: true,
    extra_refs: [{ org: "acme", repo: "app", base_ref: "main", workdir: true }],
    spec: { serviceAccountName: "e2e", containers: [{ ...container, args: ["test", "-tags", "e2e", "./..."] }] },
  }),
];
`;

/** The spec Prow's pjutil copies from a job into the ProwJob it creates, for the schema check without Go. */
export function specOf(type: string, job: Record<string, unknown>, repo?: string): Record<string, unknown> {
  const [org, name] = (repo ?? "/").split("/");
  return {
    type,
    agent: "kubernetes",
    job: job.name,
    cluster: job.cluster ?? "default",
    ...(job.namespace ? { namespace: job.namespace } : {}),
    ...(job.max_concurrency ? { max_concurrency: job.max_concurrency } : {}),
    ...(job.decoration_config ? { decoration_config: job.decoration_config } : {}),
    ...(job.rerun_command ? { rerun_command: job.rerun_command } : {}),
    ...(job.extra_refs ? { extra_refs: job.extra_refs } : {}),
    ...(job.reporter_config ? { reporter_config: job.reporter_config } : {}),
    ...(type !== "periodic" ? { refs: { org, repo: name, base_ref: "main", base_sha: "0".repeat(40) } } : {}),
    report: true,
    pod_spec: job.spec,
  };
}

export async function builtConfigs(): Promise<Array<[string, string]>> {
  const authored = await buildSources({ "jobs.ts": AUTHORED });
  expect(authored.errors).toEqual([]);
  const full = await roundTrip(fixture("terragucci/full.yaml"));
  expect(full.errors).toEqual([]);
  return [
    ["authored", authored.output],
    ["terragucci full, imported and built", full.output],
  ];
}

