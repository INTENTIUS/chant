# Testing

chant uses [Vitest](https://vitest.dev/) for all tests. The test suite includes 1000+ passing tests across the project.

> **See also**: [Core Concepts](docs/src/content/docs/guides/core-concepts.md) for information on testing declarables, intrinsics, and error handling patterns.

## Quick Start

```bash
# Run all tests
npx vitest run

# Run tests for a specific package
npx vitest run packages/core
npx vitest run lexicons/aws
npx vitest run packages/test-utils

# Run a single test file
npx vitest run packages/core/src/errors.test.ts

# Run tests matching a pattern
npx vitest run -t "DiscoveryError"

# Run tests in watch mode
npx vitest

# Run with coverage
npx vitest run --coverage
```

## Test Organization

Tests are colocated with source files using the `.test.ts` suffix:

```
packages/core/src/
├── errors.ts
├── errors.test.ts      # Tests for errors.ts
├── discovery/
│   ├── files.ts
│   └── files.test.ts   # Tests for files.ts
```

### Test Distribution

- **core**: 19 test files - Core functionality including discovery, lint engine, and build system
- **aws**: 11 test files - AWS CloudFormation domain and resource generation
- **cli**: 7 test files - Command-line interface and CLI utilities
- **test-utils**: 1 test file - Shared testing utilities

## Testing Patterns

### Filesystem Tests

Use `withTestDir()` from `@intentius/chant-test-utils` for tests that need temporary directories. This utility automatically creates and cleans up test directories:

```typescript
import { withTestDir } from "@intentius/chant-test-utils";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

test("creates file", async () => {
  await withTestDir(async (dir) => {
    // dir is a unique temp directory (e.g., /tmp/chant-test-1234567890-0.123)
    await writeFile(join(dir, "app.ts"), "export const app = {};");

    // Test your code that uses the directory
    const files = await findInfraFiles(dir);
    expect(files).toHaveLength(1);

    // Directory is automatically cleaned up after the test
  });
});
```

Alternative approach for manual control:

```typescript
import { createTestDir, cleanupTestDir } from "@intentius/chant-test-utils";

test("manual cleanup", async () => {
  const dir = await createTestDir();
  try {
    // Your test code
  } finally {
    await cleanupTestDir(dir);
  }
});
```

**Example**: See `packages/core/src/discovery/files.test.ts`

### Mock Object Factories

Use mock factories from `@intentius/chant-test-utils` to create test objects (see [Core Concepts](docs/src/content/docs/guides/core-concepts.md#declarables) for declarable type details):

```typescript
import {
  createMockEntity,
  createMockDomain,
  createMockLintRule,
  createMockLintContext,
} from "@intentius/chant-test-utils";

test("processes entity", () => {
  const entity = createMockEntity("TestEntity");
  expect(entity.entityType).toBe("TestEntity");
});

test("serializes domain", () => {
  const domain = createMockDomain("test");
  const entities = new Map([["myEntity", createMockEntity()]]);
  const output = domain.serialize(entities);
  expect(output).toContain("resources");
});

test("runs lint rule", () => {
  const rule = createMockLintRule("test-rule", [
    { message: "Error found", line: 1, column: 5 }
  ]);
  const context = createMockLintContext("const x = 1;", "test.ts");
  const diagnostics = rule.check(context);
  expect(diagnostics).toHaveLength(1);
});
```

**Example**: See `packages/core/src/lint/rule.test.ts`

### Error Assertions

Use `expectToThrow()` from `@intentius/chant-test-utils` to test error conditions (see [Error Handling](docs/src/content/docs/guides/core-concepts.md#error-handling) for error type details):

```typescript
import { expectToThrow } from "@intentius/chant-test-utils";
import { DiscoveryError } from "./errors";

test("throws DiscoveryError on import failure", async () => {
  const error = await expectToThrow(
    () => importModule("/invalid/path.ts"),
    DiscoveryError
  );

  expect(error.type).toBe("import");
  expect(error.file).toBe("/invalid/path.ts");
});

test("validates error properties", async () => {
  await expectToThrow(
    () => buildEntity("BadEntity"),
    BuildError,
    (error) => {
      expect(error.entityName).toBe("BadEntity");
      expect(error.message).toContain("Failed to build");
    }
  );
});
```

**Example**: See `packages/core/src/errors.test.ts`

### Async Code Testing

Vitest handles async tests automatically:

```typescript
test("async operation completes", async () => {
  const result = await fetchData();
  expect(result).toBeDefined();
});

test("promise rejects with error", async () => {
  await expectToThrow(
    async () => await failingOperation(),
    Error
  );
});
```

## Writing New Tests

### Test File Location

- Place test files next to the source files they test
- Use the `.test.ts` suffix (e.g., `utils.ts` → `utils.test.ts`)
- Do not use `.spec.ts` (not the project convention)

### Test Naming Conventions

```typescript
import { describe, test, expect } from "vitest";

describe("ModuleName", () => {
  test("does something specific", () => {
    // Test implementation
  });

  test("handles edge case", () => {
    // Edge case test
  });
});
```

- Use `describe()` to group related tests by module or feature
- Use `test()` for individual test cases
- Write test names in present tense describing the behavior
- Be specific: "creates error with file path" not "works correctly"

### Using Shared Test Utilities

Always import utilities from `@intentius/chant-test-utils` (enabled by TypeScript path aliases):

```typescript
import {
  withTestDir,
  createMockEntity,
  expectToThrow,
} from "@intentius/chant-test-utils";
```

Benefits:
- Consistent test patterns across packages
- Automatic cleanup and error handling
- Type-safe mock objects
- Better test isolation

### Testing Error Conditions

When testing error handling:

1. Use `expectToThrow()` for expected errors
2. Validate error properties (type, message, context)
3. Test both sync and async error paths

```typescript
test("validates input", async () => {
  await expectToThrow(
    () => validateInput(""),
    ValidationError,
    (error) => {
      expect(error.message).toContain("required");
    }
  );
});
```

## Skipped Tests

Some tests are skipped because they require network access or external resources. These are marked with `test.skip()`:

### Network Integration Tests

**Location**: `packages/aws/src/spec/fetch.test.ts`

Three tests are skipped because they require network access to fetch AWS CloudFormation specs:

- `"fetches spec from AWS (integration)"` - Tests live API fetch
- `"caches spec after fetch (integration)"` - Tests caching behavior
- `"uses cache on second fetch (integration)"` - Tests cache reuse

**To run these tests**:

```bash
# Remove .skip from the test file or run with network access
npx vitest run packages/aws/src/spec/fetch.test.ts
```

These tests are skipped by default to:
- Allow offline development
- Avoid API rate limits in CI/CD
- Speed up the test suite

In a CI environment, you would typically mock the AWS API calls or run these tests separately as integration tests.

## Coverage

### Current Status

- **Test files**: 458 files across the project
- **Assertions**: 1000+ `expect()` calls

### Generating Coverage Reports

```bash
# Generate coverage report (text format by default)
npx vitest run --coverage

# Generate lcov format for coverage tools
npx vitest run --coverage --coverage-reporter=lcov
```

### Coverage Goals

While no specific coverage thresholds are currently enforced, the test suite aims for:

- All error classes should have comprehensive tests
- All public APIs should have happy path and error path tests
- All discovery and build logic should be tested
- Filesystem operations should use `withTestDir()` for isolation

### Adding Tests for New Code

When adding new functionality:

1. Write tests alongside your code in a `.test.ts` file
2. Test both success and failure cases
3. Use shared utilities from `@intentius/chant-test-utils`
4. Run tests before committing: `npx vitest run`

## Additional Test Options

### Running Specific Tests

```bash
# Run only tests matching a pattern
npx vitest run -t "pattern"

# Re-run failed tests (retry flaky tests)
npx vitest run --retry=3

# Run tests in a specific file
npx vitest run path/to/file.test.ts
```

### Debugging Tests

```bash
# Set test timeout (default: 5000ms)
npx vitest run --testTimeout=10000
```

## CI/CD Integration

The test suite is designed to run in continuous integration:

- No external dependencies by default (network tests are skipped)
- Deterministic results with automatic cleanup
- Exit code 0 on success, non-zero on failure

Example CI configuration:

```yaml
# GitHub Actions example
- name: Run tests
  run: npx vitest run

- name: Generate coverage
  run: npx vitest run --coverage --coverage-reporter=lcov
```

## Smoke Tests (Docker)

Smoke tests run inside Docker containers to verify chant works in a clean environment with no host state leaking in. Each Docker image / test path maps to a specific **persona** with clear questions it answers.

### Persona: New User (`just smoke-npm` / `smoke.sh npm`)

**"I npm installed chant. Does it work?"**

- Installs chant + each lexicon from tarballs (simulates `npm install`)
- Runs `chant init --lexicon <X>` for all 6 lexicons
- Builds and lints scaffolded projects
- Builds and lints hand-crafted projects
- Builds real cross-lexicon examples from packages
- Tested by `Dockerfile.smoke-npm` → `npm-smoke.sh`

### Persona: Developer / Contributor (`just smoke-workspace` / `smoke.sh workspace`)

**"I cloned the repo. Does everything work?"**

- Fresh checkout + `npm install` + build from workspace
- Full CLI coverage for all 6 lexicons: build, lint, list, doctor, init
- MCP and LSP server startup
- Output formats: `--output` file, `--format yaml`, `--format json`, `--format sarif`
- `chant init lexicon` scaffold
- Multi-stack builds
- All root cross-lexicon examples build
- Tested by `Dockerfile.smoke` → `integration.sh`

### Persona: Release Validation (`smoke.sh smoke-{aws,eks,gke,aks,all}`)

**"Do examples deploy end-to-end to real cloud providers?"**

- Actual cloud deploys: build → deploy → verify → teardown
- Requires cloud credentials mounted via Docker `-v` / `-e` flags
- Tested by `Dockerfile.smoke-e2e` → `e2e-smoke.sh`

### Build Examples (`just smoke-build-examples` / `smoke.sh build-examples`)

Builds all root examples in Docker and extracts artifacts to `test/example-builds/` for agent-driven deployment.

### justfile recipes

| Recipe | What it does |
|--------|--------------|
| `just smoke-workspace` | Developer tests — builds `Dockerfile.smoke`, runs `integration.sh`, drops into bash |
| `just smoke-npm` | New User tests — delegates to `./test/smoke.sh npm` |
| `just smoke-build-examples` | Delegates to `./test/smoke.sh build-examples` |
| `just smoke` | Runs `smoke-workspace` then `smoke-npm` |

### smoke.sh modes

| Mode | What it does |
|------|--------------|
| `workspace` | Builds `Dockerfile.smoke`, runs `integration.sh` during build (non-interactive) |
| `npm` | Runs prepack on host, then builds `Dockerfile.smoke-npm` — 3-stage tarball test |
| `build-examples` | Builds workspace image, runs `build-examples.sh`, copies artifacts to `test/example-builds/` |
| `smoke-aws` | E2E: deploys AWS/GitLab examples (needs `AWS_*` + `GITLAB_*` env vars) |
| `smoke-eks` | E2E: deploys EKS example (needs `AWS_*` + `EKS_DOMAIN`) |
| `smoke-gke` | E2E: deploys GKE example (needs GCP credentials) |
| `smoke-aks` | E2E: deploys AKS example (needs Azure credentials) |
| `smoke-all` | E2E: all 4 deployment groups |
| `all` | Runs `workspace` + `npm` (no E2E) |

### Expected artifacts (build-examples)

| Example | Artifacts |
|---------|-----------|
| `flyway-postgresql-gitlab-aws-rds` | `templates/template.json`, `flyway.toml`, `.gitlab-ci.yml` |
| `gitlab-aws-alb-infra` | `templates/template.json`, `.gitlab-ci.yml` |
| `gitlab-aws-alb-api` | `templates/template.json`, `.gitlab-ci.yml` |
| `gitlab-aws-alb-ui` | `templates/template.json`, `.gitlab-ci.yml` |
| `k8s-eks-microservice` | `templates/infra.json`, `k8s.yaml` |

Each example directory also gets `README.md`, `package.json`, and any deploy scripts (`scripts/`, `setup.sh`, `sql/`, `.env.example`) copied to `/output` for agent-driven deployment from outside the container. Skills come from the installed lexicon packages, not from the examples themselves.

### Files

| File | Purpose |
|------|---------|
| `test/smoke.sh` | Orchestrator — `workspace`, `npm`, `build-examples`, `smoke-{aws,eks,gke,aks,all}`, `all` |
| `test/Dockerfile.smoke` | Developer persona — Node.js workspace image, runs `integration.sh` during build |
| `test/Dockerfile.smoke-npm` | New User persona — 2-stage tarball image: pack, test npm |
| `test/Dockerfile.smoke-e2e` | Release persona — E2E image with deploy tools, runs `e2e-smoke.sh` at container start |
| `test/integration.sh` | Developer test harness: CLI, build, lint, MCP, LSP, init for all 6 lexicons + examples |
| `test/npm-smoke.sh` | New User test harness: tarball install, init flow, examples — all 6 lexicons, both runtimes |
| `test/e2e-smoke.sh` | E2E deployment harness: deploy, verify, teardown for AWS/GitLab, EKS, GKE, AKS |
| `test/build-examples.sh` | Builds all root examples, copies artifacts to `/output` |

## Distribution Safety

How confident can we be that published npm packages actually work for end users? This section documents what the smoke tests cover and known gaps.

### What's well covered

- **Tarball install + CLI execution**: `npm install` from tarballs for all 6 lexicons, then `chant build` and `chant lint` via `npx`
- **Tarball content verification**: Explicit assertions that core tarball contains `bin/chant`, `src/cli/main.ts`, `src/index.ts`, and each lexicon tarball contains `dist/manifest.json`, `dist/meta.json`, `dist/types/index.d.ts`, `src/index.ts`
- **`chant init` flow**: Scaffolding tested for all 6 lexicons — init, install, build, lint
- **`workspace:*` resolution**: smoke Dockerfile resolves manually with jq before packing tarballs
- **Prepack pipeline**: All lexicons run `generate → bundle → validate` with schema and artifact checks
- **Type resolution**: `tsc --noEmit` check after tarball install (soft pass — chant targets tsx with `.ts` exports, not vanilla tsc)

### Known gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| Smoke tests disabled in CI | Accepted | Docker builds are slow (~10min). Publish workflow runs `prepack` + `npx vitest run` as a gate. Run `just smoke` locally before releases. |
| `integrity.json` never verified at runtime | Low | `verifyIntegrity()` exists in `lexicon-integrity.ts` but `loadPlugin()` in `cli/plugins.ts` doesn't call it. Defense-in-depth, not a correctness issue. |
| Lexicon tarballs include entire `src/` | Low | Ships codegen scripts, fetch utilities, and test files. Bloats tarballs but doesn't break anything. Could narrow `"files"` in package.json. |
| Sequential publish — partial failure risk | Low | If npm goes down mid-publish, some packages may be at different versions. Retry with `--tolerate-republish` fixes this. Acceptable at current scale. |

## Troubleshooting

### Tests fail with "ENOENT" errors

Ensure you're using `withTestDir()` for filesystem tests. This utility handles directory creation and cleanup automatically.

### Tests timeout

Increase the timeout for long-running tests:

```typescript
test("slow operation", async () => {
  // Test code
}, { timeout: 10000 }); // 10 second timeout
```

Or use the command-line flag:

```bash
npx vitest run --testTimeout=10000
```

### Flaky tests

Run tests with retry to identify flakiness:

```bash
npx vitest run --retry=5
```

Check for:
- Race conditions in async code
- Improper cleanup of test directories
- Shared mutable state between tests
