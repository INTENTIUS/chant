import type { SerializerResult } from "../serializer";
import type { PostSynthCheck, PostSynthDiagnostic } from "./post-synth";
import { getPrimaryOutput } from "./post-synth";

/**
 * COR025: Stringified Reference in Serialized Output (#1526)
 *
 * kubemicrovm-ops composed a bucket policy's resource ARN with a template
 * literal — `` `${bucket.Arn}/*` `` — over an `AttrRef`, not a string.
 * JavaScript stringifies any non-primitive interpolated into a template
 * literal via `Object.prototype.toString`, so the emitted policy carried the
 * literal substring `"[object Object]/*"` in place of the resolved ARN. That
 * built clean and linted clean — nothing upstream of serialization sees a
 * type error, because `AttrRef` IS an object and a template literal accepts
 * any coercible value — and it deployed clean on floci, which does no
 * policy validation. It failed the first real deploy with S3 rejecting the
 * policy's `Resource` and rolling back the stack.
 *
 * `[object Object]` (and its array-of-objects sibling `[object Object,object
 * Object]`) never appears in a serialized template/manifest on purpose: no
 * lexicon's serializer ever emits it, and no cloud provider's schema ever
 * expects it as a literal value. Its presence is only ever a reference that
 * got coerced to a string instead of resolved. That makes this check cheap,
 * universal across lexicons (it scans the emitted text, not any one
 * lexicon's schema), and free of false positives worth caring about — see
 * `stringifiedReferenceCheck` below.
 *
 * Scans `ctx.outputs` (the SYNTHESIZED text) rather than `ctx.entities`
 * because the coercion already happened in the user's own declaration code,
 * upstream of anything chant's model retains structurally — by the time an
 * entity reaches `ctx.entities` its prop is already a plain string containing
 * the marker, indistinguishable from any other string prop. The only place
 * left to catch it lexicon-independently is the text chant actually emits.
 */

const MARKER = "[object Object]";

export const STRINGIFIED_REFERENCE_CHECK_ID = "COR025";

/** Trim a matched line down to a readable snippet without truncating mid-marker. */
const MAX_SNIPPET_LENGTH = 200;

function lineContaining(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const nextNewline = text.indexOf("\n", index);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  const line = text.slice(lineStart, lineEnd).trim();
  return line.length > MAX_SNIPPET_LENGTH ? `${line.slice(0, MAX_SNIPPET_LENGTH)}…` : line;
}

/** Every serialized file for one lexicon's output: the primary plus any nested files. */
function serializedFiles(output: string | SerializerResult): Record<string, string> {
  const files: Record<string, string> = { primary: getPrimaryOutput(output) };
  if (typeof output !== "string" && output.files) {
    Object.assign(files, output.files);
  }
  return files;
}

const stringifiedReferenceCheck: PostSynthCheck = {
  id: STRINGIFIED_REFERENCE_CHECK_ID,
  description:
    'A serialized output contains the literal substring "[object Object]" — a reference that was ' +
    "stringified (e.g. through a template literal or string concatenation) instead of resolved. " +
    "Always an authoring error, never intentional output.",
  check(ctx) {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [lexicon, output] of ctx.outputs) {
      for (const [fileLabel, content] of Object.entries(serializedFiles(output))) {
        const seenLines = new Set<string>();
        let index = content.indexOf(MARKER);
        while (index !== -1) {
          const line = lineContaining(content, index);
          const dedupeKey = `${fileLabel}::${line}`;
          if (!seenLines.has(dedupeKey)) {
            seenLines.add(dedupeKey);
            const location = fileLabel === "primary" ? "" : ` (${fileLabel})`;
            diagnostics.push({
              checkId: STRINGIFIED_REFERENCE_CHECK_ID,
              severity: "error",
              lexicon,
              message:
                `Serialized output${location} contains "${MARKER}" — a reference was stringified ` +
                `instead of resolved (a template literal or string concatenation over an object, ` +
                `not the raw value/ref). Emitted line: ${line}`,
            });
          }
          index = content.indexOf(MARKER, index + MARKER.length);
        }
      }
    }
    return diagnostics;
  },
};

/** Core-owned post-synth checks over serialized output text (#1526). */
export function coreOutputChecks(): PostSynthCheck[] {
  return [stringifiedReferenceCheck];
}
