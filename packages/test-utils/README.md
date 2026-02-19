# @intentius/chant-test-utils

> Part of the [chant](../../README.md) monorepo. Internal package — not published to npm.

Shared testing utilities for chant packages.

## Overview

This package provides testing utilities used across all chant packages:

- **Filesystem utilities**: Temporary directory creation and cleanup
- **Mock factories**: Create test declarables, serializers, lint rules, and contexts
- **Error assertions**: Test error conditions with `expectToThrow`
- **Test isolation**: Automatic cleanup and error handling

## Filesystem Utilities

### withTestDir

The recommended way to test filesystem operations. Automatically creates and cleans up temporary directories:

```typescript
import { withTestDir } from "@intentius/chant-test-utils";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

test("creates file", async () => {
  await withTestDir(async (dir) => {
    // dir is a unique temp directory
    // Example: /tmp/chant-test-1234567890-0.123
    await writeFile(join(dir, "app.ts"), "export const app = {};");

    // Test your code that uses the directory
    const files = await findInfraFiles(dir);
    expect(files).toHaveLength(1);

    // Directory is automatically cleaned up after the test
  });
});
```

Benefits:
- Unique directory per test (no conflicts)
- Automatic cleanup (even if test fails)
- Async-safe (handles concurrent tests)
- No manual cleanup code needed

### createTestDir / cleanupTestDir

For manual control over directory lifecycle:

```typescript
import { createTestDir, cleanupTestDir } from "@intentius/chant-test-utils";

test("manual cleanup", async () => {
  const dir = await createTestDir();
  try {
    // Your test code
    await writeFile(join(dir, "test.ts"), "code");
  } finally {
    await cleanupTestDir(dir);
  }
});
```

When to use manual cleanup:
- You need the directory path before the test logic
- You're sharing a directory across multiple operations
- You want explicit control over cleanup timing

## Mock Factories

### createMockEntity

Create test declarable entities:

```typescript
import { createMockEntity } from "@intentius/chant-test-utils";

test("processes entity", () => {
  const entity = createMockEntity("TestEntity");

  expect(entity.entityType).toBe("TestEntity");
  expect(entity[DECLARABLE_MARKER]).toBe(true);
});

// With custom properties
const entityWithProps = createMockEntity("AWS::S3::Bucket", {
  bucketName: "my-bucket",
  versioning: { status: "Enabled" },
});
```

### createMockSerializer

Create test serializer implementations:

```typescript
import { createMockSerializer } from "@intentius/chant-test-utils";

test("serializes entities", () => {
  const serializer = createMockSerializer("test");

  const entities = new Map([
    ["myEntity", createMockEntity("TestType")],
  ]);

  const output = serializer.serialize(entities);
  expect(output).toContain("resources");
  expect(output).toContain("myEntity");
});

// Custom serialization
const customSerializer = createMockSerializer("custom", {
  serialize: (entities) => {
    return JSON.stringify({
      custom: Array.from(entities.keys()),
    });
  },
});
```

### createMockLintRule

Create test lint rules:

```typescript
import { createMockLintRule } from "@intentius/chant-test-utils";

test("runs lint rule", () => {
  const rule = createMockLintRule("test-rule", [
    { message: "Error found", line: 1, column: 5 },
  ]);

  const context = createMockLintContext("const x = 1;", "test.ts");
  const diagnostics = rule.check(context);

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].message).toBe("Error found");
  expect(diagnostics[0].line).toBe(1);
});

// With custom check function
const customRule = createMockLintRule("custom-rule", [], {
  check: (context) => {
    // Custom lint logic
    if (context.sourceFile.text.includes("bad")) {
      return [{
        message: "Found 'bad' keyword",
        line: 1,
        column: 1,
        ruleId: "custom-rule",
        severity: "error",
      }];
    }
    return [];
  },
});
```

### createMockLintContext

Create test lint contexts:

```typescript
import { createMockLintContext } from "@intentius/chant-test-utils";

test("analyzes code", () => {
  const context = createMockLintContext(
    'const x = "us-east-1";',
    "test.ts"
  );

  expect(context.filePath).toBe("test.ts");
  expect(context.sourceFile).toBeDefined();
  expect(context.sourceFile.text).toContain("us-east-1");
});
```

## Error Assertions

### expectToThrow

Test that code throws expected errors:

```typescript
import { expectToThrow } from "@intentius/chant-test-utils";
import { DiscoveryError } from "@intentius/chant";

test("throws DiscoveryError on import failure", async () => {
  const error = await expectToThrow(
    () => importModule("/invalid/path.ts"),
    DiscoveryError
  );

  expect(error.type).toBe("import");
  expect(error.file).toBe("/invalid/path.ts");
});

// With validation callback
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

// Async errors
test("handles async errors", async () => {
  await expectToThrow(
    async () => await fetchData(),
    Error
  );
});
```

Features:
- Type-safe error checking
- Supports sync and async functions
- Optional validation callback
- Fails if no error is thrown
- Fails if wrong error type is thrown

## Test Patterns

### Filesystem Tests

Always use `withTestDir` for filesystem operations:

```typescript
import { withTestDir } from "@intentius/chant-test-utils";

test("discovers files", async () => {
  await withTestDir(async (dir) => {
    // Create test files
    await writeFile(join(dir, "app.ts"), "export const app = {};");
    await writeFile(join(dir, "config.ts"), "export const config = {};");

    // Test discovery
    const files = await findInfraFiles(dir);
    expect(files).toHaveLength(2);
  });
});
```

### Error Testing

Use `expectToThrow` for all error conditions:

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

### Mock Objects

Use mock factories for consistent test objects:

```typescript
test("serializes entity", () => {
  const serializer = createMockSerializer("test");
  const entity = createMockEntity("TestType", { name: "test" });
  const entities = new Map([["testEntity", entity]]);

  const output = serializer.serialize(entities);
  expect(output).toBeDefined();
});
```

## Usage with Bun Test

These utilities are designed for [Bun's test runner](https://bun.sh/docs/cli/test):

```typescript
import { test, expect, describe } from "bun:test";
import { withTestDir, createMockEntity, expectToThrow } from "@intentius/chant-test-utils";

describe("MyModule", () => {
  test("does something", async () => {
    await withTestDir(async (dir) => {
      // Test code
    });
  });

  test("handles errors", async () => {
    await expectToThrow(() => myFunction(), Error);
  });
});
```

## TypeScript Support

This package is written in TypeScript and provides full type definitions for all utilities.

## Examples

See the test files across chant packages for usage examples:

- `packages/core/src/discovery/files.test.ts` - Filesystem testing
- `packages/core/src/errors.test.ts` - Error assertion testing
- `packages/core/src/lint/rule.test.ts` - Mock factory usage
- `lexicons/aws/src/serializer.test.ts` - Serializer testing

## Documentation

- [Testing Guide](../../TESTING.md) - Comprehensive testing documentation with patterns and examples
- [Core Concepts](../../docs/src/content/docs/guides/core-concepts.md) - Understanding declarables and errors

## Related Packages

- `@intentius/chant` - Core functionality and types
- `@intentius/chant-lexicon-aws` - AWS CloudFormation lexicon

## License

See the main project LICENSE file.
