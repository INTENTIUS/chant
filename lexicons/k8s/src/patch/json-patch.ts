/**
 * RFC 6902 JSON Patch and RFC 7386 JSON Merge Patch, for rendered documents.
 *
 * Core carries an RFC 6902 applier for cfn-lint codegen
 * (`packages/core/src/codegen/json-patch.ts`), but it skips `test`, `move`
 * and `copy`, and it works on JSON strings. A patch on a rendered manifest
 * needs `test` most of all: it is how an author pins the value a chart
 * upgrade might change underneath them. So this module is a small, complete
 * applier over plain objects, with no imports, usable from the build path and
 * from the helm lexicon's `HelmRender`.
 *
 * Both appliers return a new document and never mutate their input.
 */

/** One RFC 6902 operation. `path` and `from` are RFC 6901 JSON Pointers. */
export type JsonPatchOperation =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: unknown };

type Container = Record<string, unknown> | unknown[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** "" -> [], "/a/b~1c" -> ["a", "b/c"]. */
function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`"${pointer}" is not a JSON Pointer (it must start with "/")`);
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function arrayIndex(arr: unknown[], token: string, pointer: string, allowEnd: boolean): number {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new Error(`"${token}" in ${pointer} is not an array index`);
  const idx = Number(token);
  const max = allowEnd ? arr.length : arr.length - 1;
  if (idx > max) throw new Error(`index ${idx} in ${pointer} is out of bounds (array length ${arr.length})`);
  return idx;
}

function get(root: unknown, pointer: string): unknown {
  let current = root;
  for (const token of parsePointer(pointer)) {
    if (Array.isArray(current)) {
      current = current[arrayIndex(current, token, pointer, false)];
    } else if (isObject(current) && Object.prototype.hasOwnProperty.call(current, token)) {
      current = current[token];
    } else {
      throw new Error(`path ${pointer} does not exist`);
    }
  }
  return current;
}

/** The container a pointer's last token addresses, and that token. */
function parentOf(root: unknown, pointer: string): { parent: Container; token: string } {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) throw new Error("the root cannot be addressed as a member");
  const token = tokens.pop()!;
  const parentPointer = tokens.length === 0 ? "" : "/" + tokens.map((t) => t.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
  const parent = get(root, parentPointer);
  if (!Array.isArray(parent) && !isObject(parent)) {
    throw new Error(`path ${pointer} does not exist (its parent is not an object or array)`);
  }
  return { parent, token };
}

function add(root: unknown, pointer: string, value: unknown): unknown {
  if (pointer === "") return value;
  const { parent, token } = parentOf(root, pointer);
  if (Array.isArray(parent)) {
    if (token === "-") parent.push(value);
    else parent.splice(arrayIndex(parent, token, pointer, true), 0, value);
  } else {
    parent[token] = value;
  }
  return root;
}

function remove(root: unknown, pointer: string): unknown {
  if (pointer === "") throw new Error("the document root cannot be removed");
  const { parent, token } = parentOf(root, pointer);
  if (Array.isArray(parent)) {
    parent.splice(arrayIndex(parent, token, pointer, false), 1);
  } else {
    if (!Object.prototype.hasOwnProperty.call(parent, token)) throw new Error(`path ${pointer} does not exist`);
    delete parent[token];
  }
  return root;
}

function replace(root: unknown, pointer: string, value: unknown): unknown {
  if (pointer === "") return value;
  get(root, pointer); // must exist
  const { parent, token } = parentOf(root, pointer);
  if (Array.isArray(parent)) parent[arrayIndex(parent, token, pointer, false)] = value;
  else parent[token] = value;
  return root;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Apply an RFC 6902 patch. Operations apply in order; the first one that
 * fails (a missing path, a failed `test`) throws with its index, and the
 * input is left untouched.
 */
export function applyJsonPatch<T>(doc: T, operations: readonly JsonPatchOperation[]): T {
  let root: unknown = clone(doc);
  operations.forEach((operation, i) => {
    try {
      switch (operation.op) {
        case "add":
          root = add(root, operation.path, clone(operation.value));
          break;
        case "remove":
          root = remove(root, operation.path);
          break;
        case "replace":
          root = replace(root, operation.path, clone(operation.value));
          break;
        case "move": {
          if (operation.path.startsWith(operation.from + "/")) {
            throw new Error(`cannot move ${operation.from} into its own child ${operation.path}`);
          }
          const value = get(root, operation.from);
          root = remove(root, operation.from);
          root = add(root, operation.path, value);
          break;
        }
        case "copy":
          root = add(root, operation.path, clone(get(root, operation.from)));
          break;
        case "test": {
          const actual = get(root, operation.path);
          if (!deepEqual(actual, operation.value)) {
            throw new Error(
              `test failed at ${operation.path}: expected ${JSON.stringify(operation.value)}, found ${JSON.stringify(actual)}`,
            );
          }
          break;
        }
        default:
          throw new Error(`unknown op "${(operation as { op: unknown }).op}"`);
      }
    } catch (err) {
      throw new Error(`operation ${i} (${operation.op}): ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return root as T;
}

/**
 * Apply an RFC 7386 merge patch: objects merge key by key, a `null` value
 * deletes the key, and anything else (arrays included) replaces the target
 * whole.
 */
export function applyMergePatch<T>(doc: T, patch: unknown): T {
  if (!isObject(patch)) return clone(patch) as T;
  const target: Record<string, unknown> = isObject(doc) ? clone(doc) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete target[key];
    else target[key] = applyMergePatch(target[key], value);
  }
  return target as T;
}
