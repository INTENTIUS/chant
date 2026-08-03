# @intentius/chant-test-utils

Internal testing utilities for the [chant](https://intentius.io/chant/) monorepo. Not published to npm.

Provides shared helpers used across all chant packages: temporary directory
management (`withTestDir`), mock factories for plugins, serializers, lint rules
and contexts, typed error assertions (`expectToThrow`), the **example test
harness**, and the **observation conformance suite**. Written for vitest, which
is what the repo runs (`npx vitest run`).

## Example Test Harness

The example harness (`@intentius/chant-test-utils/example-harness`) centralizes example testing so each lexicon has a single `examples.test.ts` instead of per-example test files. It auto-discovers example subdirectories and runs lint + build tests for each.

### Quick start

```typescript
// lexicons/my-lexicon/examples/examples.test.ts
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { mySerializer } from "@intentius/chant-lexicon-my-lexicon";

describeAllExamples({
  lexicon: "my-lexicon",
  serializer: mySerializer,
  outputKey: "my-lexicon",
  examplesDir: import.meta.dirname,
});
```

This scans `examplesDir` for subdirectories containing a `src/` folder and registers a `describe()` block for each with two tests: **passes lint** and **build succeeds**.

### Per-example overrides

Pass custom assertions or skip tests for specific examples:

```typescript
describeAllExamples(config, {
  "my-example": {
    checks: (output) => {
      expect(output).toContain("expected-content");
    },
  },
  "docs-snippets": { skipLint: true, skipBuild: true },
  "wip-example": { skipLint: true },
});
```

### Single example

Use `describeExample` for one-off examples or cross-lexicon scenarios:

```typescript
import { describeExample } from "@intentius/chant-test-utils/example-harness";

describeExample("aws-k8s", {
  lexicon: "aws-k8s",
  serializer: [awsSerializer, k8sSerializer],
  outputKey: ["aws", "k8s"],
  examplesDir: import.meta.dirname,
});
```

### API

#### `describeAllExamples(config, overrides?)`

Auto-discovers all subdirectories with `src/` under `config.examplesDir` and registers tests.

#### `describeExample(name, config, opts?)`

Registers a `describe()` block for a single example with lint + build tests.

#### `ExampleHarnessConfig`

| Field | Type | Description |
|-------|------|-------------|
| `lexicon` | `string` | Label used in describe block names |
| `serializer` | `Serializer \| Serializer[]` | Serializer(s) to build with |
| `outputKey` | `string \| string[]` | Key(s) in `result.outputs` map to assert |
| `examplesDir` | `string` | Directory to scan (use `import.meta.dirname`) |

#### `ExampleOpts`

| Field | Type | Description |
|-------|------|-------------|
| `checks` | `(output: string) => void` | Custom assertions on the primary output |
| `skipLint` | `boolean` | Skip the lint test |
| `skipBuild` | `boolean` | Skip the build test |

## Observation conformance suite

`describeObservationConformance` is the enforcement half of the observation
contract (chant #1089): a shared suite each observing lexicon runs against its
own mocked transport. Seven lexicons run it today. It checks that a result
normalizes, that every unobserved entity carries a total reason, that ownership
verdicts match the lexicon's declared marker channel (chant #1348), and — the
point of the thing — that an unreadable entity classifies as `unobserved` rather
than `create` through core's real change set.

```typescript
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { myPlugin } from "./plugin";

describeObservationConformance({
  lexicon: "my-lexicon",
  ownershipChannel: myPlugin.ownershipChannel,
  scenarios: [
    {
      name: "a read that fails on credentials",
      declared: ["myEntity"],
      expectUnobserved: ["myEntity"],
      run: () => { /* invoke describeResources with the transport mocked */ },
    },
  ],
});
```

See [Implementing Observation](https://intentius.io/chant/lexicon-authoring/observation/)
for what each scenario field means.

## Other helpers

| Export | What it is |
|--------|------------|
| `withTestDir` / `createTestDir` / `cleanupTestDir` | Temporary directories, created and cleaned up around a test |
| `expectToThrow` | Typed error assertion |
| `createMockPlugin` | A minimal `LexiconPlugin`, with optional describe/observe/emulator members |
| `staticDescribeResources` / `staticObservation` / `staticDeepObservation` / `staticListArtifacts` | Canned observation results for a mock plugin |
| `createMockTemporalClient` | Stands in for a Temporal connection |
| `FIXTURE` | Shared fixture constants |

### Adding a new example

1. Create `lexicons/<lexicon>/examples/<name>/src/` with your TypeScript source files
2. Add a `package.json` in `lexicons/<lexicon>/examples/<name>/` (workspace member)
3. The centralized `examples.test.ts` auto-discovers it — no test file changes needed
4. If your example needs custom assertions or lint/build skips, add an override entry

## License

See the main project LICENSE file.
