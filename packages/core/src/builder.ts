import type { Declarable } from "./declarable";

/**
 * Base class for builder pattern implementations
 *
 * Provides a fluent API for constructing Declarable entities.
 * Subclasses should implement the build() method to return
 * a fully constructed Declarable entity.
 *
 * @example
 * ```ts
 * class ResourceBuilder extends Builder<MyResource> {
 *   private name?: string;
 *   private type?: string;
 *
 *   withName(name: string): this {
 *     this.name = name;
 *     return this;
 *   }
 *
 *   withType(type: string): this {
 *     this.type = type;
 *     return this;
 *   }
 *
 *   build(): MyResource {
 *     if (!this.name || !this.type) {
 *       throw new Error("Name and type are required");
 *     }
 *     return {
 *       entityType: "MyResource",
 *       [DECLARABLE_MARKER]: true,
 *       name: this.name,
 *       type: this.type,
 *     };
 *   }
 * }
 *
 * const resource = new ResourceBuilder()
 *   .withName("myResource")
 *   .withType("custom")
 *   .build();
 * ```
 */
export abstract class Builder<T extends Declarable> {
  /**
   * Builds and returns the final Declarable entity
   *
   * Subclasses must implement this method to construct
   * and return the entity with all configured properties.
   *
   * @returns The constructed Declarable entity
   * @throws Error if required properties are not set
   */
  abstract build(): T;
}
