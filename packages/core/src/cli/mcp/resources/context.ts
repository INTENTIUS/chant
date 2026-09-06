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

## Ops

An Op is a convergent verb. Each \`*.op.ts\` file declares one with named phases and activity steps; \`--on <lexicon>\` picks the runtime that hosts the run, and the built-in local runtime runs it in-process otherwise.

### Op MCP Tools

| Tool | Description |
|---|---|
| \`op-list\` | List all discovered Ops with their current run state. |
| \`op-run\` | Run an Op and return its result. Requires \`name\`. |
| \`op-status\` | Get current run state (state, step records, times). Requires \`name\`. |
| \`op-approve\` | Record a gate's resolution and wake the runtime hosting the run. Requires \`name\` and \`gate\`. |
| \`op-report\` | Return a markdown report for the latest run. Requires \`name\`. |

All Op tools accept an optional \`runtime\` parameter: a lexicon name whose \`opRuntime\` hosts the run, or \`local\` (the default) for the built-in in-process runtime.

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
