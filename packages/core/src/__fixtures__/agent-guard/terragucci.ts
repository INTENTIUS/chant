/**
 * terragucci's agent guard words and rules, as packages/terragucci/src/guard.ts
 * passes them to chant's `installAgentGuard` (#4770). Its tests, ported from
 * terragucci's test/guard.test.ts, run against these.
 */
import type { AgentGuardEngine, AgentGuardSpec } from "../../agent-guard";

const tf: AgentGuardEngine = {
  refuse: ["apply", "destroy", "import", "taint", "untaint", "force-unlock"],
  refuseSub: { state: ["rm", "mv", "push", "replace-provider"] },
  refuseFlags: ["-auto-approve", "-terragrunt-auto-approve"],
  dirFlags: ["-chdir", "-working-dir", "-terragrunt-working-dir"],
};

export const TERRAGUCCI_GUARD: AgentGuardSpec = {
  words: {
    product: "terragucci",
    refusal:
      "{what} is refused{where}. Propose the change instead: commit it to a branch and call the propose tool of terragucci mcp --propose, which pushes the branch and opens a pull request. The pipeline plans it, and a person approves its apply. init, validate, fmt and plan still run here.",
    where: " in {root}, a root of this repo's pipeline",
  },
  rules: {
    engines: {
      tofu: tf,
      terraform: tf,
      terragrunt: {
        ...tf,
        allFlags: ["--all", "-a"],
        prefixes: [{ words: ["run-all"], all: true }, { words: ["stack", "run"], all: true }, { words: ["run"] }],
      },
      choudoufu: tf,
    },
    product: {
      commands: [["stage", "tf-apply"], ["approve"], ["override"], ["unlock-state"], ["pr-merge"]],
      flagValues: [["--mode", "apply"]],
    },
    wrapperExit: 3,
  },
};
