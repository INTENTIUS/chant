/**
 * The job configs the prow generators write (#5189), one for each kind of
 * job chant generates for GitHub, for the generator tests and the loader
 * test.
 */
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateProwPipeline } from "../components/generate-pipeline";
import { generateProwOpPipeline } from "../components/generate-op-pipeline";

const step = { kind: "shell", reason: "t" };

/** db, api needing db, and web needing api: three waves. */
export const COMPONENTS = [
  { name: "db", dependsOn: [], deploy: [{ phase: "Apply", steps: [step] }] },
  { name: "api", dependsOn: ["db"], deploy: [{ phase: "Publish", steps: [{ kind: "publish-image", reason: "p" }] }, { phase: "Apply", steps: [step] }] },
  { name: "web", dependsOn: ["api"], deploy: [{ phase: "Apply", steps: [step] }] },
] as unknown as DriverComponent[];

const repo = { forgeRepo: "acme/app" };

/** Each kind, by what GitHub calls it, with the job config the prow generators write for it. */
export function generatedConfigs(): Array<[string, string]> {
  return [
    ["deploy pipeline", generateProwPipeline(COMPONENTS, { ...repo, env: "prod" }).yaml],
    ["deploy pipeline with a promote job", generateProwPipeline(COMPONENTS, { ...repo, env: "staging", promoteTo: "prod" }).yaml],
    ["gated waves", generateProwPipeline(COMPONENTS, { ...repo, env: "prod", gatedWaves: { gate: "rollout" } }).yaml],
    ["pull request loop: plan and record", generateProwPipeline(COMPONENTS, { ...repo, env: "prod", prLoop: {} }).yaml],
    [
      "pull request loop: plan, check, apply on merge with a gate per wave, stale notes",
      generateProwPipeline(COMPONENTS, {
        ...repo,
        env: "prod",
        prLoop: { applyOnMerge: true, checkJob: true, staleNotes: true, build: true, events: true },
        gatedWaves: { gate: "pr-apply" },
        prow: { serviceAccounts: { plan: "chant-plan", apply: "chant-apply" } },
      }).yaml,
    ],
    [
      "workspace member's pull request loop",
      generateProwPipeline(COMPONENTS, { ...repo, env: "prod", prLoop: { applyOnMerge: true }, member: { name: "infra", dir: "stacks/infra" } }).yaml,
    ],
    [
      "scheduled Ops",
      generateProwOpPipeline(
        [
          { name: "driftCheck", trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "issue" },
          { name: "applyOnPush", trigger: { kind: "push", branches: ["main"] } },
          { name: "lintPr", trigger: { kind: "pull_request" } },
        ],
        repo,
      ).files[0]!.yaml,
    ],
  ];
}
