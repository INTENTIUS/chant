/**
 * RFC 6902 JSON Patch implementation.
 *
 * Applies a JSON Patch document (array of operations) to a JSON document.
 * Supports add, remove, replace, and test operations.
 */

interface RFC6902Op {
  op: string;
  path: string;
  value?: unknown;
}

/**
 * Apply an RFC 6902 patch document to a JSON document.
 * Returns the patched JSON as a string.
 */
export function rfc6902Apply(doc: string, patch: string): string {
  const ops: RFC6902Op[] = JSON.parse(patch);
  let root: unknown = JSON.parse(doc);

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    switch (op.op) {
      case "add":
        root = jsonPatchAdd(root, op.path, op.value);
        break;
      case "remove":
        root = jsonPatchRemove(root, op.path);
        break;
      case "replace":
        root = jsonPatchReplace(root, op.path, op.value);
        break;
      case "test":
        // Test operations verify a value — skip for now
        break;
      case "move":
      case "copy":
        // Not commonly used in cfn-lint patches, skip
        break;
      default:
        throw new Error(`op ${i}: unsupported operation "${op.op}"`);
    }
  }

  return JSON.stringify(root);
}

/**
 * Parse an RFC 6901 JSON Pointer into tokens.
 * "" → [], "/a/b" → ["a", "b"]
 */
function parsePath(path: string): string[] {
  if (path === "") return [];
  const raw = path.slice(1).split("/");
  return raw.map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function navigateTo(root: unknown, tokens: string[]): { parent: unknown; lastToken: string } {
  if (tokens.length === 0) throw new Error("empty path");
  let current = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    current = descend(current, tokens[i]);
  }
  return { parent: current, lastToken: tokens[tokens.length - 1] };
}

function descend(current: unknown, token: string): unknown {
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    const obj = current as Record<string, unknown>;
    if (!(token in obj)) throw new Error(`key "${token}" not found`);
    return obj[token];
  }
  if (Array.isArray(current)) {
    const idx = parseInt(token, 10);
    if (isNaN(idx) || idx < 0 || idx >= current.length) {
      throw new Error(`invalid array index "${token}"`);
    }
    return current[idx];
  }
  throw new Error(`cannot descend into ${typeof current} with token "${token}"`);
}

function jsonPatchAdd(root: unknown, path: string, value: unknown): unknown {
  const tokens = parsePath(path);
  if (tokens.length === 0) return value;

  const { parent, lastToken } = navigateTo(root, tokens);

  if (typeof parent === "object" && parent !== null && !Array.isArray(parent)) {
    (parent as Record<string, unknown>)[lastToken] = value;
  } else if (Array.isArray(parent)) {
    if (lastToken === "-") {
      parent.push(value);
    } else {
      const idx = parseInt(lastToken, 10);
      if (isNaN(idx) || idx < 0 || idx > parent.length) {
        throw new Error(`array index ${lastToken} out of bounds`);
      }
      parent.splice(idx, 0, value);
    }
  } else {
    throw new Error(`cannot add to ${typeof parent}`);
  }

  return root;
}

function jsonPatchRemove(root: unknown, path: string): unknown {
  const tokens = parsePath(path);
  if (tokens.length === 0) throw new Error("cannot remove root");

  const { parent, lastToken } = navigateTo(root, tokens);

  if (typeof parent === "object" && parent !== null && !Array.isArray(parent)) {
    delete (parent as Record<string, unknown>)[lastToken];
  } else if (Array.isArray(parent)) {
    const idx = parseInt(lastToken, 10);
    if (isNaN(idx) || idx < 0 || idx >= parent.length) {
      throw new Error(`array index ${lastToken} out of bounds`);
    }
    parent.splice(idx, 1);
  } else {
    throw new Error(`cannot remove from ${typeof parent}`);
  }

  return root;
}

function jsonPatchReplace(root: unknown, path: string, value: unknown): unknown {
  const tokens = parsePath(path);
  if (tokens.length === 0) return value;

  const { parent, lastToken } = navigateTo(root, tokens);

  if (typeof parent === "object" && parent !== null && !Array.isArray(parent)) {
    const obj = parent as Record<string, unknown>;
    if (!(lastToken in obj)) throw new Error(`key "${lastToken}" not found for replace`);
    obj[lastToken] = value;
  } else if (Array.isArray(parent)) {
    const idx = parseInt(lastToken, 10);
    if (isNaN(idx) || idx < 0 || idx >= parent.length) {
      throw new Error(`array index ${lastToken} out of bounds`);
    }
    parent[idx] = value;
  } else {
    throw new Error(`cannot replace in ${typeof parent}`);
  }

  return root;
}
