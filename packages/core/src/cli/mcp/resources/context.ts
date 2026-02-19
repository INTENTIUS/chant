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

## Best Practices

1. **Flat Declarations**: Keep declarations at module level, avoid deep nesting
2. **Use AttrRefs**: Reference other resources via AttrRef, not string interpolation
3. **Lexicon-specific Rules**: Each lexicon has lint rules (WAW001, etc.)
4. **Type Safety**: Leverage TypeScript for infrastructure definitions
`;
}
