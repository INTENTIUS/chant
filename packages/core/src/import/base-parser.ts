/**
 * Base class for template value parsers.
 *
 * Implements the generic recursive walk: null → array → single-key
 * intrinsic dispatch → plain object → primitive. Subclasses provide
 * format-specific intrinsic dispatch.
 */

export abstract class BaseValueParser {
  /**
   * Try to interpret a single-key object as an intrinsic function.
   * Return the parsed intrinsic value, or null if this key isn't an intrinsic.
   */
  protected abstract dispatchIntrinsic(
    key: string,
    value: unknown,
    obj: Record<string, unknown>,
  ): unknown | null;

  /**
   * Parse a value recursively: null → array → single-key intrinsic → object → primitive.
   */
  parseValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;

    if (Array.isArray(value)) {
      return value.map((v) => this.parseValue(v));
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);

      if (keys.length === 1) {
        const result = this.dispatchIntrinsic(keys[0], obj[keys[0]], obj);
        if (result !== null) return result;
      }

      const parsed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        parsed[k] = this.parseValue(v);
      }
      return parsed;
    }

    return value;
  }
}
