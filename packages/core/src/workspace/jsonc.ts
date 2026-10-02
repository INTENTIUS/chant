/**
 * A small JSON reader that keeps positions, for the workspace declaration
 * (#2534). `chant.workspace.json` is strict JSON; `chant.workspace.jsonc` also
 * allows `//` and `/* *\/` comments and trailing commas.
 *
 * `JSON.parse` would do for the strict file, but it reports neither a line
 * nor a column in every runtime, it accepts duplicate keys by keeping the last
 * one, and it can't say where a value sits once parsed. A schema error has to
 * name the line it comes from, so this reader records where each value and
 * each key starts, by JSON Pointer.
 */

export interface TextLocation {
  /** 1-based. */
  line: number;
  /** 1-based, counted in UTF-16 code units. */
  column: number;
}

export interface JsonParseOptions {
  /** Allow comments and trailing commas (`.jsonc`). */
  jsonc: boolean;
}

export type JsonParseResult =
  | {
      ok: true;
      value: unknown;
      /**
       * Where the value at `pointer` starts, or where its key starts when
       * `key` is set. Falls back to the nearest ancestor that has a position.
       */
      locate(pointer: string, key?: boolean): TextLocation;
    }
  | { ok: false; message: string; location: TextLocation };

class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/** Escape one reference token for a JSON Pointer (RFC 6901). */
export function pointerToken(token: string | number): string {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function parseJsonText(text: string, options: JsonParseOptions): JsonParseResult {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const toLocation = (offset: number): TextLocation => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
  };

  const values = new Map<string, number>();
  const keys = new Map<string, number>();
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const fail = (message: string, offset = i): never => {
    throw new JsonSyntaxError(message, offset);
  };
  const describe = (offset: number): string =>
    offset >= text.length ? "the end of the file" : `${JSON.stringify(text[offset])}`;

  function skip(): void {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
      } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
        if (!options.jsonc) fail("comments are only allowed in chant.workspace.jsonc");
        if (text[i + 1] === "/") {
          while (i < text.length && text[i] !== "\n") i++;
        } else {
          const end = text.indexOf("*/", i + 2);
          if (end < 0) fail("unterminated /* comment");
          i = end + 2;
        }
      } else {
        return;
      }
    }
  }

  function parseString(): string {
    const start = i;
    i++;
    for (;;) {
      if (i >= text.length) fail("unterminated string", start);
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c < 0x20) fail("control character in a string; escape it", i);
      i += c === 0x5c ? 2 : 1;
    }
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      return fail("invalid escape in a string", start);
    }
  }

  function parseValue(pointer: string): unknown {
    skip();
    values.set(pointer, i);
    const c = text[i];
    if (c === "{") return parseObject(pointer);
    if (c === "[") return parseArray(pointer);
    if (c === '"') return parseString();
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return value;
      }
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    return fail(`expected a value, found ${describe(i)}`);
  }

  function parseObject(pointer: string): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    const seen = new Set<string>();
    i++;
    skip();
    if (text[i] === "}") {
      i++;
      return obj;
    }
    for (;;) {
      skip();
      if (text[i] !== '"') fail(`expected a quoted key, found ${describe(i)}`);
      const keyAt = i;
      const key = parseString();
      if (seen.has(key)) fail(`duplicate key ${JSON.stringify(key)}`, keyAt);
      seen.add(key);
      const child = `${pointer}/${pointerToken(key)}`;
      keys.set(child, keyAt);
      skip();
      if (text[i] !== ":") fail(`expected ":" after key ${JSON.stringify(key)}, found ${describe(i)}`);
      i++;
      // defineProperty, so a "__proto__" key is data and never a prototype.
      Object.defineProperty(obj, key, { value: parseValue(child), enumerable: true, writable: true, configurable: true });
      skip();
      if (text[i] === ",") {
        i++;
        skip();
        if (text[i] === "}") {
          if (!options.jsonc) fail("trailing comma; only chant.workspace.jsonc allows one");
          i++;
          return obj;
        }
        continue;
      }
      if (text[i] === "}") {
        i++;
        return obj;
      }
      fail(`expected "," or "}", found ${describe(i)}`);
    }
  }

  function parseArray(pointer: string): unknown[] {
    const arr: unknown[] = [];
    i++;
    skip();
    if (text[i] === "]") {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue(`${pointer}/${arr.length}`));
      skip();
      if (text[i] === ",") {
        i++;
        skip();
        if (text[i] === "]") {
          if (!options.jsonc) fail("trailing comma; only chant.workspace.jsonc allows one");
          i++;
          return arr;
        }
        continue;
      }
      if (text[i] === "]") {
        i++;
        return arr;
      }
      fail(`expected "," or "]", found ${describe(i)}`);
    }
  }

  try {
    skip();
    if (i >= text.length) fail("the file is empty");
    const value = parseValue("");
    skip();
    if (i < text.length) fail(`unexpected ${describe(i)} after the value`);
    return {
      ok: true,
      value,
      locate(pointer, key) {
        if (key && keys.has(pointer)) return toLocation(keys.get(pointer)!);
        for (let p = pointer; ; p = p.slice(0, p.lastIndexOf("/"))) {
          const at = values.get(p);
          if (at !== undefined) return toLocation(at);
          if (p === "") return toLocation(0);
        }
      },
    };
  } catch (err) {
    if (!(err instanceof JsonSyntaxError)) throw err;
    return { ok: false, message: err.message, location: toLocation(err.offset) };
  }
}
