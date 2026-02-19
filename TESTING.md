# Testing

chant uses [Bun's built-in test runner](https://bun.sh/docs/cli/test) for all tests. The test suite includes 1288+ passing tests across the project.

> **See also**: [Core Concepts](docs/src/content/docs/guides/core-concepts.md) for information on testing declarables, intrinsics, and error handling patterns.

## Quick Start

```bash
# Run all tests
bun test

# Run tests for a specific package
bun test packages/core
bun test packages/aws
bun test packages/test-utils

# Run a single test file
bun test packages/core/src/errors.test.ts

# Run tests matching a pattern
bun test --test-name-pattern "DiscoveryError"

# Run tests in watch mode
bun test --watch

# Run with coverage
bun test --coverage
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

Bun test runner handles async tests automatically:

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
import { describe, test, expect } from "bun:test";

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
bun test packages/aws/src/spec/fetch.test.ts
```

These tests are skipped by default to:
- Allow offline development
- Avoid API rate limits in CI/CD
- Speed up the test suite

In a CI environment, you would typically mock the AWS API calls or run these tests separately as integration tests.

## Coverage

### Current Status

- **Total tests**: 646 passing, 3 skipped
- **Test files**: 54 files across 4 packages
- **Assertions**: 1420+ `expect()` calls

### Generating Coverage Reports

```bash
# Generate coverage report (text format by default)
bun test --coverage

# Generate lcov format for coverage tools
bun test --coverage --coverage-reporter=lcov

# Specify coverage output directory
bun test --coverage --coverage-dir=coverage-reports
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
4. Run tests before committing: `bun test`

## Additional Test Options

### Running Specific Tests

```bash
# Run only tests marked with test.only()
bun test --only

# Run tests marked with test.todo()
bun test --todo

# Re-run each test file multiple times (catch flaky tests)
bun test --rerun-each=5

# Run tests in random order
bun test --randomize
```

### Debugging Tests

```bash
# Show only failures
bun test --only-failures

# Set test timeout (default: 5000ms)
bun test --timeout=10000

# Bail after N failures
bun test --bail=1
```

### Controlling Concurrency

```bash
# Limit concurrent test execution (default: 20)
bun test --max-concurrency=5

# Run all tests concurrently
bun test --concurrent
```

## CI/CD Integration

The test suite is designed to run in continuous integration:

- Fast execution (~230ms for full suite)
- No external dependencies by default (network tests are skipped)
- Deterministic results with automatic cleanup
- Exit code 0 on success, non-zero on failure

Example CI configuration:

```yaml
# GitHub Actions example
- name: Run tests
  run: bun test

- name: Generate coverage
  run: bun test --coverage --coverage-reporter=lcov
```

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
bun test --timeout=10000
```

### Flaky tests

Run tests multiple times to identify flakiness:

```bash
bun test --rerun-each=10 --randomize
```

Check for:
- Race conditions in async code
- Improper cleanup of test directories
- Shared mutable state between tests
