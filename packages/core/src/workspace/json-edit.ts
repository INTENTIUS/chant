/**
 * Edit one property of a JSON or JSONC document in place (#3308), for the
 * write commands that change a field of the workspace declaration.
 *
 * Only the text of the property changed is touched: the rest of the file
 * keeps its indentation, key order, line endings, comments and trailing
 * commas. A new property goes after the last one of its object, indented
 * like it. The caller re-parses the result and compares it with the value it
 * meant to write, so an edit this module gets wrong is never written.
 */

import { parseJsonText, pointerToken } from "./jsonc";

export class JsonEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonEditError";
  }
}

type Parsed = Extract<ReturnType<typeof parseJsonText>, { ok: true }>;

function parse(text: string, jsonc: boolean): Parsed {
  const r = parseJsonText(text, { jsonc });
  if (!r.ok) throw new JsonEditError(`the file does not parse: ${r.message} at line ${r.location.line}, column ${r.location.column}`);
  return r;
}

/** The value at a JSON Pointer, or undefined. */
export function valueAt(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  let at: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (at === null || typeof at !== "object") return undefined;
    if (Array.isArray(at)) at = at[Number(token)];
    else at = Object.prototype.hasOwnProperty.call(at, token) ? (at as Record<string, unknown>)[token] : undefined;
  }
  return at;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The text's line ending, and the indentation one level adds (the first indented line's, else two spaces). */
function style(text: string): { eol: string; unit: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const m = /\n([ \t]+)\S/.exec(text);
  return { eol, unit: m ? (m[1].startsWith("\t") ? "\t" : m[1]) : "  " };
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineIndent(text: string, offset: number): string {
  const start = lineStart(text, offset);
  return /^[ \t]*/.exec(text.slice(start))![0];
}

/** The offset of the next character after `from` that is not whitespace or a comment. */
function skipTrivia(text: string, from: number): number {
  let i = from;
  for (;;) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
    else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else return i;
  }
}

function render(value: unknown, indent: string, unit: string, eol: string): string {
  return JSON.stringify(value, null, unit).split("\n").join(eol + indent);
}

/**
 * Set `key` of the object at `objectPointer` to `value`: replace the value's
 * text when the key is there, else add the key after the object's last one.
 * Throws a {@link JsonEditError} when there is no object at the pointer.
 */
export function setProperty(text: string, jsonc: boolean, objectPointer: string, key: string, value: unknown): string {
  const r = parse(text, jsonc);
  const parent = valueAt(r.value, objectPointer);
  if (!isObject(parent)) throw new JsonEditError(`there is no object at ${objectPointer || "the root"}`);
  const { eol, unit } = style(text);
  const child = r.span(`${objectPointer}/${pointerToken(key)}`);
  if (child) return text.slice(0, child.start) + render(value, lineIndent(text, child.key ?? child.start), unit, eol) + text.slice(child.end);

  const obj = r.span(objectPointer)!;
  const parentIndent = lineIndent(text, obj.key ?? obj.start);
  const keys = Object.keys(parent);
  if (keys.length === 0) {
    const indent = parentIndent + unit;
    return `${text.slice(0, obj.start)}{${eol}${indent}${JSON.stringify(key)}: ${render(value, indent, unit, eol)}${eol}${parentIndent}}${text.slice(obj.end)}`;
  }
  const last = r.span(`${objectPointer}/${pointerToken(keys[keys.length - 1])}`)!;
  const next = skipTrivia(text, last.end);
  const trailingComma = text[next] === ",";
  if (lineStart(text, last.key!) === lineStart(text, obj.start)) {
    // An object on one line stays on one line.
    const entry = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    return trailingComma ? `${text.slice(0, next + 1)} ${entry},${text.slice(next + 1)}` : `${text.slice(0, last.end)}, ${entry}${text.slice(last.end)}`;
  }
  const indent = lineIndent(text, last.key!);
  const after = trailingComma ? next + 1 : last.end;
  // After a comment that ends the last property's line, so the comment stays with it.
  const eolAt = text.indexOf("\n", after);
  const lineEnd = eolAt < 0 ? text.length : text[eolAt - 1] === "\r" ? eolAt - 1 : eolAt;
  const at = /^[ \t]*(\/\/.*)?$/.test(text.slice(after, lineEnd)) ? lineEnd : after;
  const entry = `${eol}${indent}${JSON.stringify(key)}: ${render(value, indent, unit, eol)}`;
  if (trailingComma) return `${text.slice(0, at)}${entry},${text.slice(at)}`;
  return `${text.slice(0, last.end)},${text.slice(last.end, at)}${entry}${text.slice(at)}`;
}

/** Remove `key` from the object at `objectPointer`, with the comma that went with it. Unchanged when the key is not there. */
export function removeProperty(text: string, jsonc: boolean, objectPointer: string, key: string): string {
  const r = parse(text, jsonc);
  const parent = valueAt(r.value, objectPointer);
  if (!isObject(parent)) throw new JsonEditError(`there is no object at ${objectPointer || "the root"}`);
  const child = r.span(`${objectPointer}/${pointerToken(key)}`);
  if (!child) return text;
  const keys = Object.keys(parent);
  const obj = r.span(objectPointer)!;
  if (keys.length === 1) return `${text.slice(0, obj.start)}{}${text.slice(obj.end)}`;
  const next = skipTrivia(text, child.end);
  if (text[next] === ",") {
    const start = lineStart(text, child.key!);
    const ownLine = /^[ \t]*$/.test(text.slice(start, child.key!));
    let to = next + 1;
    const eolAt = text.indexOf("\n", to);
    if (ownLine && /^[ \t\r]*$/.test(text.slice(to, eolAt < 0 ? text.length : eolAt))) to = eolAt < 0 ? text.length : eolAt + 1;
    else while (text[to] === " ") to++;
    return text.slice(0, ownLine ? start : child.key!) + text.slice(to);
  }
  // The last property, with no trailing comma: remove from the comma after the one before it.
  const prev = r.span(`${objectPointer}/${pointerToken(keys[keys.indexOf(key) - 1])}`)!;
  const comma = skipTrivia(text, prev.end);
  return text.slice(0, comma) + text.slice(child.end);
}

/**
 * Add `value` to the end of the array at `arrayPointer` (#3596), indented
 * like the element before it, or on its own line in an empty array. An array
 * on one line stays on one line. Throws a {@link JsonEditError} when there is
 * no array at the pointer.
 */
export function appendElement(text: string, jsonc: boolean, arrayPointer: string, value: unknown): string {
  const r = parse(text, jsonc);
  const arr = valueAt(r.value, arrayPointer);
  if (!Array.isArray(arr)) throw new JsonEditError(`there is no array at ${arrayPointer || "the root"}`);
  const { eol, unit } = style(text);
  const span = r.span(arrayPointer)!;
  const parentIndent = lineIndent(text, span.key ?? span.start);
  if (arr.length === 0) {
    // Inside the brackets, after anything already there, such as a comment.
    const indent = parentIndent + unit;
    const inside = text.slice(span.start + 1, span.end - 1).replace(/\s+$/, "");
    return `${text.slice(0, span.start)}[${inside}${eol}${indent}${render(value, indent, unit, eol)}${eol}${parentIndent}]${text.slice(span.end)}`;
  }
  const last = r.span(`${arrayPointer}/${arr.length - 1}`)!;
  const next = skipTrivia(text, last.end);
  const trailingComma = text[next] === ",";
  if (lineStart(text, last.start) === lineStart(text, span.start)) {
    const entry = JSON.stringify(value);
    return trailingComma ? `${text.slice(0, next + 1)} ${entry},${text.slice(next + 1)}` : `${text.slice(0, last.end)}, ${entry}${text.slice(last.end)}`;
  }
  const indent = lineIndent(text, last.start);
  const after = trailingComma ? next + 1 : last.end;
  const eolAt = text.indexOf("\n", after);
  const lineEnd = eolAt < 0 ? text.length : text[eolAt - 1] === "\r" ? eolAt - 1 : eolAt;
  const at = /^[ \t]*(\/\/.*)?$/.test(text.slice(after, lineEnd)) ? lineEnd : after;
  const entry = `${eol}${indent}${render(value, indent, unit, eol)}`;
  if (trailingComma) return `${text.slice(0, at)}${entry},${text.slice(at)}`;
  return `${text.slice(0, last.end)},${text.slice(last.end, at)}${entry}${text.slice(at)}`;
}

/** Replace the element at `index` of the array at `arrayPointer` with `value` (#3596). Throws a {@link JsonEditError} when there is none. */
export function setElement(text: string, jsonc: boolean, arrayPointer: string, index: number, value: unknown): string {
  const r = parse(text, jsonc);
  const arr = valueAt(r.value, arrayPointer);
  if (!Array.isArray(arr) || index < 0 || index >= arr.length) throw new JsonEditError(`there is no element ${index} in an array at ${arrayPointer || "the root"}`);
  const { eol, unit } = style(text);
  const span = r.span(arrayPointer)!;
  const child = r.span(`${arrayPointer}/${index}`)!;
  const value_ = lineStart(text, child.start) === lineStart(text, span.start) ? JSON.stringify(value) : render(value, lineIndent(text, child.start), unit, eol);
  return text.slice(0, child.start) + value_ + text.slice(child.end);
}

/** Remove the element at `index` of the array at `arrayPointer`, with the comma that went with it (#3596). Throws a {@link JsonEditError} when there is none. */
export function removeElement(text: string, jsonc: boolean, arrayPointer: string, index: number): string {
  const r = parse(text, jsonc);
  const arr = valueAt(r.value, arrayPointer);
  if (!Array.isArray(arr) || index < 0 || index >= arr.length) throw new JsonEditError(`there is no element ${index} in an array at ${arrayPointer || "the root"}`);
  const child = r.span(`${arrayPointer}/${index}`)!;
  const next = skipTrivia(text, child.end);
  if (text[next] === "," || arr.length === 1) {
    const start = lineStart(text, child.start);
    const ownLine = /^[ \t]*$/.test(text.slice(start, child.start));
    // The only element may have no comma after it.
    let to = text[next] === "," ? next + 1 : child.end;
    const eolAt = text.indexOf("\n", to);
    if (ownLine && /^[ \t\r]*$/.test(text.slice(to, eolAt < 0 ? text.length : eolAt))) to = eolAt < 0 ? text.length : eolAt + 1;
    else while (text[to] === " ") to++;
    return text.slice(0, ownLine ? start : child.start) + text.slice(to);
  }
  // The last element, with no trailing comma: remove from the comma after the one before it.
  const prev = r.span(`${arrayPointer}/${index - 1}`)!;
  const comma = skipTrivia(text, prev.end);
  return text.slice(0, comma) + text.slice(child.end);
}
