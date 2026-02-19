import type { LexiconPlugin } from "../lexicon";

export interface ConflictEntry {
  type: "rule-id" | "skill-name" | "mcp-tool" | "mcp-resource";
  key: string;
  plugins: string[];
}

export interface ConflictReport {
  conflicts: ConflictEntry[];
  warnings: ConflictEntry[];
}

/**
 * Check loaded lexicon plugins for cross-lexicon conflicts.
 *
 * - Duplicate rule IDs are hard conflicts (should cause a throw at load time).
 * - Duplicate skill, MCP tool, or MCP resource names are soft conflicts (warnings).
 */
export function checkConflicts(plugins: LexiconPlugin[]): ConflictReport {
  const conflicts: ConflictEntry[] = [];
  const warnings: ConflictEntry[] = [];

  // Check rule ID conflicts (hard conflict)
  const ruleIds = new Map<string, string[]>();
  for (const plugin of plugins) {
    const rules = plugin.lintRules?.() ?? [];
    for (const rule of rules) {
      const existing = ruleIds.get(rule.id) ?? [];
      existing.push(plugin.name);
      ruleIds.set(rule.id, existing);
    }
  }
  for (const [id, owners] of ruleIds) {
    if (owners.length > 1) {
      conflicts.push({ type: "rule-id", key: id, plugins: owners });
    }
  }

  // Check skill name conflicts (warning)
  const skillNames = new Map<string, string[]>();
  for (const plugin of plugins) {
    const skills = plugin.skills?.() ?? [];
    for (const skill of skills) {
      const existing = skillNames.get(skill.name) ?? [];
      existing.push(plugin.name);
      skillNames.set(skill.name, existing);
    }
  }
  for (const [name, owners] of skillNames) {
    if (owners.length > 1) {
      warnings.push({ type: "skill-name", key: name, plugins: owners });
    }
  }

  // Check MCP tool name conflicts (warning)
  const mcpToolNames = new Map<string, string[]>();
  for (const plugin of plugins) {
    const tools = plugin.mcpTools?.() ?? [];
    for (const tool of tools) {
      const existing = mcpToolNames.get(tool.name) ?? [];
      existing.push(plugin.name);
      mcpToolNames.set(tool.name, existing);
    }
  }
  for (const [name, owners] of mcpToolNames) {
    if (owners.length > 1) {
      warnings.push({ type: "mcp-tool", key: name, plugins: owners });
    }
  }

  // Check MCP resource URI conflicts (warning)
  const mcpResourceUris = new Map<string, string[]>();
  for (const plugin of plugins) {
    const resources = plugin.mcpResources?.() ?? [];
    for (const resource of resources) {
      const existing = mcpResourceUris.get(resource.uri) ?? [];
      existing.push(plugin.name);
      mcpResourceUris.set(resource.uri, existing);
    }
  }
  for (const [uri, owners] of mcpResourceUris) {
    if (owners.length > 1) {
      warnings.push({ type: "mcp-resource", key: uri, plugins: owners });
    }
  }

  return { conflicts, warnings };
}
