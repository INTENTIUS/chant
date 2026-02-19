# @intentius/chant

> Part of the [chant](../../README.md) monorepo. Published as [`@intentius/chant`](https://www.npmjs.com/package/@intentius/chant) on npm.

Core functionality for chant - a lexicon-agnostic declarative infrastructure specification system.

## Overview

This package provides the foundational types, interfaces, and utilities that power chant's declarative infrastructure system. It includes:

- **Type system**: Declarables, Intrinsics, Parameters, and Outputs
- **Discovery system**: File scanning, module loading, and entity collection
- **Build pipeline**: Dependency resolution, topological sorting, and serialization
- **Error handling**: Structured errors for discovery, build, and lint phases
- **Lint system**: Infrastructure code validation framework
- **Template import**: Convert external templates to TypeScript
- **Codegen infrastructure**: Reusable pipelines for generating, naming, packaging, and fetching schemas
- **LSP providers**: Generic lexicon-based completion and hover helpers
- **Runtime factories**: `createResource` and `createProperty` for Declarable-marked constructors

## Key Concepts

### Declarables

A `Declarable` is any entity that can be declared in an infrastructure specification:

```typescript
import { isDeclarable, DECLARABLE_MARKER } from "@intentius/chant";

if (isDeclarable(value)) {
  console.log(value.entityType);
}
```

### Intrinsics

An `Intrinsic` represents a lexicon-provided function resolved at build time:

```typescript
import { isIntrinsic, INTRINSIC_MARKER } from "@intentius/chant";

if (isIntrinsic(value)) {
  const serialized = value.toJSON();
}
```

### AttrRef

Reference attributes of other entities with deferred resolution:

```typescript
import { AttrRef } from "@intentius/chant";

const bucket = {};
const arnRef = new AttrRef(bucket, "arn");

// Later, during discovery
arnRef._setLogicalName("MyBucket");
arnRef.toJSON(); // { "Fn::GetAttr": ["MyBucket", "arn"] }
```

## Discovery System

Discover and collect infrastructure entities from TypeScript files:

```typescript
import { discover } from "@intentius/chant";

const result = await discover("./src/infra");
// result.entities: Map of entity name to Declarable
// result.dependencies: Dependency graph
// result.sourceFiles: Discovered files
// result.errors: Any errors encountered
```

### Individual Discovery Functions

```typescript
import {
  findInfraFiles,
  importModule,
  collectEntities,
  resolveAttrRefs,
  buildDependencyGraph,
  detectCycles,
  topologicalSort,
} from "@intentius/chant";

// Find all .ts files (excluding tests and node_modules)
const files = await findInfraFiles("./src");

// Import a module
const exports = await importModule("./src/resources.ts");

// Collect declarables from modules
const entities = collectEntities([
  { file: "resources.ts", exports }
]);

// Resolve attribute references
resolveAttrRefs(entities);

// Build dependency graph
const deps = buildDependencyGraph(entities);

// Check for cycles
const cycles = detectCycles(deps);

// Topological sort
const order = topologicalSort(deps);
```

## Build Pipeline

Build infrastructure specifications with lexicon-specific serialization:

```typescript
import { build } from "@intentius/chant";
import { myLexicon } from "@intentius/chant-lexicon-myplatform";

const result = await build("./src/infra", [myLexicon]);
// result.outputs: Map of lexicon name to serialized output
// result.entities: Discovered entities
// result.warnings: Build warnings
// result.errors: Any errors
```

## Error Handling

Structured error types for different phases:

```typescript
import { DiscoveryError, BuildError, LintError } from "@intentius/chant";

// Discovery phase errors
throw new DiscoveryError("config.ts", "Module not found", "import");

// Build phase errors
throw new BuildError("MyResource", "Invalid configuration");

// Lint errors with location
const error = new LintError(
  "config.ts",
  10,
  5,
  "no-unused",
  "Variable is declared but never used"
);

// All errors support JSON serialization
const json = error.toJSON();
```

## Lint System

Validate infrastructure code with custom rules:

```typescript
import { parseFile } from "@intentius/chant";
import type { LintRule, LintContext } from "@intentius/chant";

// Parse a file for linting
const sourceFile = parseFile("./src/infra/main.ts");

// Define a lint rule
const myRule: LintRule = {
  id: "my-rule",
  severity: "error",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    // Analyze context.sourceFile
    return [];
  },
  fix(context: LintContext): LintFix[] {
    // Optional: provide auto-fixes
    return [];
  }
};
```

## Serializer Interface

Implement lexicon-specific serialization:

```typescript
import type { Serializer, Declarable } from "@intentius/chant";

const mySerializer: Serializer = {
  name: "my-lexicon",
  rulePrefix: "ML",
  serialize(entities: Map<string, Declarable>): string {
    // Serialize entities to lexicon-specific format
    return JSON.stringify({ entities: Array.from(entities.keys()) });
  }
};
```

## Utilities

Helper functions for working with declarables:

```typescript
import {
  getAttributes,
  getLogicalName,
  LOGICAL_NAME_SYMBOL
} from "@intentius/chant";

// Get attribute names that have AttrRef values
const attrs = getAttributes(myEntity);
// ["arn", "endpoint"]

// Get the logical name assigned during discovery
(entity as any)[LOGICAL_NAME_SYMBOL] = "MyResource";
const name = getLogicalName(entity);
// "MyResource"
```

## Lexicon Detection

Automatically detect which lexicon is being used:

```typescript
import { detectLexicon } from "@intentius/chant";

const lexicon = await detectLexicon(["./src/infra/main.ts"]);
// "aws" (currently the only supported lexicon)
```

## Template Import System

Convert external templates to TypeScript:

```typescript
import type {
  TemplateIR,
  TemplateParser,
  TypeScriptGenerator
} from "@intentius/chant";

// Parser converts external format to IR
const parser: TemplateParser = {
  parse(content: string): TemplateIR {
    return { resources: [], parameters: [] };
  }
};

// Generator converts IR to TypeScript
const generator: TypeScriptGenerator = {
  generate(ir: TemplateIR): GeneratedFile[] {
    return [{ path: "resources.ts", content: "..." }];
  }
};
```

## Codegen Infrastructure

Core provides reusable infrastructure for lexicon code generation pipelines. Lexicons supply provider-specific callbacks; core handles orchestration.

### Runtime Factories

Create Declarable-marked constructors for generated resource and property types:

```typescript
import { createResource, createProperty } from "@intentius/chant/runtime";

// Creates a constructor that stamps out Declarable objects
const MyResource = createResource("Provider::Service::Type", "my-lexicon", { arn: "Arn" });
const MyProperty = createProperty("Provider::Service::Type.PropType", "my-lexicon");
```

### Naming Strategy

Collision-free TypeScript class name generation, parameterized by data tables:

```typescript
import { NamingStrategy, type NamingConfig } from "@intentius/chant/codegen/naming";

const config: NamingConfig = {
  priorityNames: { "Provider::S3::Bucket": "Bucket" },
  priorityAliases: {},
  priorityPropertyAliases: {},
  serviceAbbreviations: { "ElasticLoadBalancingV2": "Elbv2" },
  shortName: (t) => t.split("::").pop()!,
  serviceName: (t) => t.split("::")[1],
};

const naming = new NamingStrategy(inputs, config);
naming.resolve("Provider::S3::Bucket"); // "Bucket"
```

### Generation Pipeline

Generic pipeline orchestration — step sequencing, logging, warning collection, stats counting:

```typescript
import { generatePipeline, type GeneratePipelineConfig } from "@intentius/chant/codegen/generate";

const config: GeneratePipelineConfig<MyParsedResult> = {
  fetchSchemas: async (opts) => { /* ... */ },
  parseSchema: (name, data) => { /* ... */ },
  createNaming: (results) => new MyNamingStrategy(results),
  generateRegistry: (results, naming) => { /* ... */ },
  generateTypes: (results, naming) => { /* ... */ },
  generateRuntimeIndex: (results, naming) => { /* ... */ },
};

const result = await generatePipeline(config, { verbose: true });
```

### Packaging Pipeline

Bundles generation output into a distributable `BundleSpec`:

```typescript
import { packagePipeline, type PackagePipelineConfig } from "@intentius/chant/codegen/package";

const result = await packagePipeline({
  generate: (opts) => myGenerate(opts),
  buildManifest: (genResult) => ({ name: "my-lexicon", version: "1.0.0", /* ... */ }),
  srcDir: __dirname,
  collectSkills: () => new Map(),
});
```

### Fetch Utilities

HTTP fetch with local file caching and zip extraction:

```typescript
import { fetchWithCache, extractFromZip } from "@intentius/chant/codegen/fetch";

const data = await fetchWithCache({ url: "https://...", cacheFile: "/tmp/cache.zip" });
const files = await extractFromZip(data, (name) => name.endsWith(".json"));
```

### LSP Providers

Generic lexicon-based completion and hover:

```typescript
import { LexiconIndex, lexiconCompletions, lexiconHover } from "@intentius/chant/lsp/lexicon-providers";

const index = new LexiconIndex(lexiconData);
const completions = lexiconCompletions(ctx, index, "My resource");
const hover = lexiconHover(ctx, index);
```

## TypeScript Support

This package is written in TypeScript and provides full type definitions.

## Documentation

- [Core Concepts](../../docs/src/content/docs/guides/core-concepts.md) - Detailed guide on declarables, intrinsics, and the type system
- [Testing Guide](../../TESTING.md) - Testing patterns and utilities

## Related Packages

- `@intentius/chant-lexicon-aws` - AWS CloudFormation lexicon
- `@intentius/chant-test-utils` - Testing utilities

## License

See the main project LICENSE file.
