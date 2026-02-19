import { describe, test, expect } from "bun:test";
import { Builder } from "./builder";
import type { Declarable } from "./declarable";
import { DECLARABLE_MARKER } from "./declarable";

// Test implementation of Declarable for testing
interface TestResource extends Declarable {
  name: string;
  type: string;
  description?: string;
}

// Simple builder implementation
class SimpleResourceBuilder extends Builder<TestResource> {
  private name?: string;
  private type?: string;
  private description?: string;

  withName(name: string): this {
    this.name = name;
    return this;
  }

  withType(type: string): this {
    this.type = type;
    return this;
  }

  withDescription(description: string): this {
    this.description = description;
    return this;
  }

  build(): TestResource {
    if (!this.name || !this.type) {
      throw new Error("Name and type are required");
    }
    return {
      entityType: "TestResource",
      [DECLARABLE_MARKER]: true,
      name: this.name,
      type: this.type,
      description: this.description,
    };
  }
}

// Complex builder with validation
class ValidatedResourceBuilder extends Builder<TestResource> {
  private name?: string;
  private type?: string;

  withName(name: string): this {
    if (!name || name.trim() === "") {
      throw new Error("Name cannot be empty");
    }
    this.name = name;
    return this;
  }

  withType(type: string): this {
    const validTypes = ["A", "B", "C"];
    if (!validTypes.includes(type)) {
      throw new Error(`Type must be one of: ${validTypes.join(", ")}`);
    }
    this.type = type;
    return this;
  }

  build(): TestResource {
    if (!this.name || !this.type) {
      throw new Error("Name and type are required");
    }
    return {
      entityType: "TestResource",
      [DECLARABLE_MARKER]: true,
      name: this.name,
      type: this.type,
    };
  }
}

// Builder with default values
class DefaultsResourceBuilder extends Builder<TestResource> {
  private name = "default-name";
  private type = "default-type";
  private description = "default-description";

  withName(name: string): this {
    this.name = name;
    return this;
  }

  withType(type: string): this {
    this.type = type;
    return this;
  }

  withDescription(description: string): this {
    this.description = description;
    return this;
  }

  build(): TestResource {
    return {
      entityType: "TestResource",
      [DECLARABLE_MARKER]: true,
      name: this.name,
      type: this.type,
      description: this.description,
    };
  }
}

describe("Builder", () => {
  describe("fluent API", () => {
    test("allows chaining multiple method calls", () => {
      const builder = new SimpleResourceBuilder()
        .withName("test-resource")
        .withType("test-type")
        .withDescription("test-description");

      const resource = builder.build();
      expect(resource.name).toBe("test-resource");
      expect(resource.type).toBe("test-type");
      expect(resource.description).toBe("test-description");
    });

    test("returns 'this' for chaining", () => {
      const builder = new SimpleResourceBuilder();
      const result1 = builder.withName("test");
      const result2 = result1.withType("type");

      expect(result1).toBe(builder);
      expect(result2).toBe(builder);
    });

    test("allows arbitrary method call order", () => {
      const resource1 = new SimpleResourceBuilder()
        .withName("test")
        .withType("type")
        .build();

      const resource2 = new SimpleResourceBuilder()
        .withType("type")
        .withName("test")
        .build();

      expect(resource1.name).toBe(resource2.name);
      expect(resource1.type).toBe(resource2.type);
    });
  });

  describe("build method", () => {
    test("returns a valid Declarable entity", () => {
      const resource = new SimpleResourceBuilder()
        .withName("test")
        .withType("type")
        .build();

      expect(resource.entityType).toBe("TestResource");
      expect(resource[DECLARABLE_MARKER]).toBe(true);
      expect(resource.name).toBe("test");
      expect(resource.type).toBe("type");
    });

    test("throws when required properties are missing", () => {
      const builder = new SimpleResourceBuilder().withName("test");

      expect(() => builder.build()).toThrow("Name and type are required");
    });

    test("includes optional properties when set", () => {
      const resource = new SimpleResourceBuilder()
        .withName("test")
        .withType("type")
        .withDescription("A test resource")
        .build();

      expect(resource.description).toBe("A test resource");
    });

    test("omits optional properties when not set", () => {
      const resource = new SimpleResourceBuilder()
        .withName("test")
        .withType("type")
        .build();

      expect(resource.description).toBeUndefined();
    });
  });

  describe("extension patterns", () => {
    test("supports custom validation in setter methods", () => {
      const builder = new ValidatedResourceBuilder();

      expect(() => builder.withName("")).toThrow("Name cannot be empty");
      expect(() => builder.withName("   ")).toThrow("Name cannot be empty");
      expect(() => builder.withType("Invalid")).toThrow(
        "Type must be one of: A, B, C"
      );
    });

    test("allows valid values through validation", () => {
      const resource = new ValidatedResourceBuilder()
        .withName("valid-name")
        .withType("A")
        .build();

      expect(resource.name).toBe("valid-name");
      expect(resource.type).toBe("A");
    });

    test("supports builders with default values", () => {
      const resource = new DefaultsResourceBuilder().build();

      expect(resource.name).toBe("default-name");
      expect(resource.type).toBe("default-type");
      expect(resource.description).toBe("default-description");
    });

    test("allows overriding default values", () => {
      const resource = new DefaultsResourceBuilder()
        .withName("custom-name")
        .build();

      expect(resource.name).toBe("custom-name");
      expect(resource.type).toBe("default-type");
      expect(resource.description).toBe("default-description");
    });
  });

  describe("reusability", () => {
    test("builder can be reused to create multiple instances", () => {
      const builder = new DefaultsResourceBuilder();

      const resource1 = builder.build();
      const resource2 = builder.build();

      // Should create separate instances
      expect(resource1).not.toBe(resource2);
      // But with same values
      expect(resource1.name).toBe(resource2.name);
      expect(resource1.type).toBe(resource2.type);
    });

    test("modifying builder after build affects next build", () => {
      const builder = new SimpleResourceBuilder()
        .withName("initial")
        .withType("type");

      const resource1 = builder.build();
      expect(resource1.name).toBe("initial");

      builder.withName("modified");
      const resource2 = builder.build();
      expect(resource2.name).toBe("modified");
    });
  });

  describe("type safety", () => {
    test("build method returns correct type", () => {
      const builder = new SimpleResourceBuilder()
        .withName("test")
        .withType("type");

      const resource = builder.build();

      // TypeScript should recognize this as TestResource
      expect(resource.entityType).toBe("TestResource");
      expect(resource.name).toBe("test");
      expect(resource.type).toBe("type");
    });

    test("fluent methods maintain builder type", () => {
      const builder = new SimpleResourceBuilder();

      // Each method should return the same builder type
      const step1 = builder.withName("test");
      const step2 = step1.withType("type");
      const step3 = step2.withDescription("desc");

      expect(step1).toBeInstanceOf(SimpleResourceBuilder);
      expect(step2).toBeInstanceOf(SimpleResourceBuilder);
      expect(step3).toBeInstanceOf(SimpleResourceBuilder);
    });
  });

  describe("error handling", () => {
    test("preserves validation errors", () => {
      const builder = new ValidatedResourceBuilder();

      try {
        builder.withType("Invalid");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Type must be one of: A, B, C");
      }
    });

    test("preserves build errors", () => {
      const builder = new SimpleResourceBuilder();

      try {
        builder.build();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Name and type are required");
      }
    });
  });
});
