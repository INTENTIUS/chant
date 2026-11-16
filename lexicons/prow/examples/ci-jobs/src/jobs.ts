import { JobConfig, Periodic, PodSpec, Postsubmit, Presubmit, Refs } from "@intentius/chant-lexicon-prow";

// The checks run before merge on a build cluster that holds no credential;
// the publish and the nightly run merged code on the one whose service
// accounts the cloud trusts. chant keeps an exported array in its order, so
// the jobs come out in the order written here.
const image = "golang:1.26";

export const jobs = [
  new JobConfig({
    header: "# Written by chant build from src/jobs.ts. Change that file and build again.",
  }),
  new Presubmit({
    repo: "acme/app",
    name: "pull-app-unit",
    cluster: "untrusted",
    always_run: true,
    decorate: true,
    branches: ["^main$"],
    spec: new PodSpec({
      automountServiceAccountToken: false,
      containers: [{ name: "test", image, command: ["go"], args: ["test", "./..."] }],
    }),
  }),
  new Presubmit({
    repo: "acme/app",
    name: "pull-app-docs",
    cluster: "untrusted",
    run_if_changed: "^docs/",
    optional: true,
    decorate: true,
    spec: new PodSpec({
      automountServiceAccountToken: false,
      containers: [{ name: "docs", image: "node:24", command: ["npx"], args: ["markdownlint-cli2", "docs/**/*.md"] }],
    }),
  }),
  new Postsubmit({
    repo: "acme/app",
    name: "post-app-publish",
    cluster: "trusted",
    decorate: true,
    max_concurrency: 1,
    branches: ["^main$"],
    skip_if_only_changed: "^docs/",
    spec: new PodSpec({
      serviceAccountName: "publisher",
      containers: [{ name: "publish", image, command: ["make"], args: ["publish"] }],
    }),
  }),
  new Periodic({
    name: "periodic-app-e2e",
    cluster: "trusted",
    cron: "0 3 * * *",
    decorate: true,
    extra_refs: [new Refs({ org: "acme", repo: "app", base_ref: "main", workdir: true })],
    spec: new PodSpec({
      serviceAccountName: "e2e",
      containers: [{ name: "e2e", image, command: ["make"], args: ["e2e"] }],
    }),
  }),
];
