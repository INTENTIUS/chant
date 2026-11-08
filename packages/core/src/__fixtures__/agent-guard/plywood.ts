/**
 * plywood's agent guard words and rules, as packages/plywood/src/guard.ts
 * passes them to chant's `installAgentGuard` (#4770). Its tests, ported from
 * plywood's test/agents.test.ts ("the agent guard"), run against these.
 */
import type { AgentGuardEngine, AgentGuardSpec } from "../../agent-guard";

const engine: AgentGuardEngine = {
  refuse: ["up", "update", "destroy"],
  valuedFlags: ["-C", "--cwd", "-s", "--stack", "--color", "--config-file", "--logflow", "-v", "--verbose", "--tracing", "--profiling", "--memprofilerate"],
};

export const PLYWOOD_GUARD: AgentGuardSpec = {
  words: {
    product: "plywood",
    refusal: "an agent session does not run '{what}'. Open a pull request; plywood previews it, and the update runs after a person approves the digest.",
  },
  rules: {
    engines: { pulumi: engine, plunge: engine },
    // plywood's own verbs that update, approve, override or move a stack, refused as terragucci refuses its own.
    product: {
      commands: [["up"], ["resume"], ["approve"], ["override"], ["cancel"], ["move"], ["rollback"], ["action"]],
      flagValues: [["--respond", "up"]],
    },
    wrapperExit: 1,
  },
};
