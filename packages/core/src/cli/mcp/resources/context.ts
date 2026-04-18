/**
 * Get the chant context for MCP
 * Returns lexicon-specific instructions and patterns
 */
export function getContext(): string {
  return `# chant Development Context

chant is a lexicon-agnostic declarative specification system for infrastructure as code.

## Key Concepts

### Declarable
Base interface for all infrastructure entities. Every resource you create must implement \`Declarable\`.

### Lexicon
Lexicons define target platforms (e.g. AWS). Each lexicon:
- Has a unique name and rule prefix
- Implements \`serialize(entities)\` to generate platform-specific output

### AttrRef
Deferred references to entity attributes. Use these for cross-resource references:
\`\`\`typescript
const bucket = new Bucket({ name: "data" });
// bucket.arn is an AttrRef that resolves at build time
\`\`\`

### Intrinsics
Lexicon-provided functions resolved at build time:
- \`Sub\` - String interpolation with references
- \`Ref\` - Reference to another resource
- \`Json\` - JSON serialization

## CLI Commands

### Build
\`\`\`bash
chant build ./infra/          # Build infrastructure
chant build ./infra/ -o out.json  # Output to file
\`\`\`

### Lint
\`\`\`bash
chant lint ./infra/           # Check for issues
\`\`\`

### Import
\`\`\`bash
chant import template.json    # Convert external template
chant import template.json -o ./src/  # Custom output dir
\`\`\`

## Ops (Temporal Workflows)

Ops are durable workflow definitions backed by Temporal. Each \`*.op.ts\` file declares an Op with named phases and activity steps.

### Op MCP Tools

| Tool | Description |
|---|---|
| \`op-list\` | List all discovered Ops with current run status. Optional \`profile\` param. |
| \`op-run\` | Submit an Op workflow. Requires \`name\`. Worker must already be running via \`chant run <name>\`. |
| \`op-status\` | Get current run state (status, activity counts, times). Requires \`name\`. |
| \`op-signal\` | Send a signal to unblock a gate step. Requires \`name\` and \`signal\`. |
| \`op-report\` | Return a markdown deployment report for the latest run. Requires \`name\`. |

All Op tools accept an optional \`profile\` parameter matching a profile name in \`chant.config.ts\` \`temporal.profiles\`.

### Op MCP Resources

| URI | Description |
|---|---|
| \`chant://ops\` | JSON array of all Op definitions (name, overview, phases, taskQueue, depends) |
| \`chant://ops/{name}/runs\` | Workflow run history for a named Op |
| \`chant://ops/{name}/runs/latest\` | Latest run state for a named Op |

### Workflow IDs
Ops use deterministic workflow IDs: \`chant-op-<opName>\` (e.g. \`chant-op-alb-deploy\`).

## Best Practices

1. **Flat Declarations**: Keep declarations at module level, avoid deep nesting
2. **Use AttrRefs**: Reference other resources via AttrRef, not string interpolation
3. **Lexicon-specific Rules**: Each lexicon has lint rules (WAW001, etc.)
4. **Type Safety**: Leverage TypeScript for infrastructure definitions
`;
}
