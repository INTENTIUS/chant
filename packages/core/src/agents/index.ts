/**
 * Agent-configuration discovery and checks.
 *
 * Finds the agent configs on a machine (`discover.ts`), judges them
 * (`checks.ts`), and normalizes both onto one vendor-neutral model
 * (`types.ts`). The two consumers are `chant audit --agents`, which reports on
 * what it finds, and `chant import --agents`, which re-expresses it as chant
 * code via a lexicon's IR mapper.
 */

export type {
  AgentConfigSite,
  AgentFinding,
  AgentRuntime,
  AgentScanResult,
  AgentScope,
  CommandDecl,
  InstructionFile,
  McpServerDecl,
  McpTransport,
  PermissionConfig,
  PluginDecl,
  SkillDecl,
  SkillOrigin,
  SubagentDecl,
} from "./types";
export { AGENT_RUNTIMES, AGENT_SCOPES } from "./types";
export { scanAgentConfigs, normalizeMcpServers, frontmatter, systemSettingsPaths, unscannedProjectCount, type ScanOptions } from "./discover";
export { checkAgentConfigs, AGENT_RULE_IDS } from "./checks";
