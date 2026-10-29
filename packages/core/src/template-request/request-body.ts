/**
 * The pull request body for a template request (#4651), and the read that
 * recovers the request from it. The body names the template, the version,
 * each input on its own row, the requester (and the claimed requester, when
 * the client names one) and where the request came from,
 * and says that nothing was applied or approved. The request itself follows
 * in a fenced block whose info string is `json` and the schema id, so behold
 * and an audit read it from the pull request without a second file.
 */

import { activeProductWords, type CiProductWords } from "../ci-product-words";
import { TEMPLATE_REQUEST_SCHEMA_ID, templateName, validateTemplateRequest, type TemplateRequest, type TemplateRequestVia } from "./template-request";

const VIA: Record<TemplateRequestVia, string> = {
  form: "the request form",
  mcp: "an agent over MCP",
  cli: "the command line",
};

/** Text in a table cell's code span, with `|` escaped so the row holds and a fence longer than any backticks inside. */
function code(text: string): string {
  const escaped = text.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const ticks = Math.max(0, ...[...escaped.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(ticks + 1);
  return ticks > 0 ? `${fence} ${escaped} ${fence}` : `${fence}${escaped}${fence}`;
}

/** A fence longer than any run of backticks in `text`, at least three. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The request's pull request body, in the product's words (default: the active ones). */
export function requestBody(request: TemplateRequest, words: CiProductWords = activeProductWords()): string {
  const what = request.kind === "addon" && request.addon !== undefined ? `add-on ${code(request.addon)} for app ${code(request.app)}` : `app ${code(request.app)}`;
  const lines: string[] = [
    `### ${words.product} request: ${what} from ${templateName(request.template)}`,
    "",
    "| | |",
    "| --- | --- |",
    `| Template | ${code(request.template)} |`,
    `| Version | ${code(request.version)} |`,
    `| Requested by | ${code(request.requestedBy)} |`,
    ...(request.claimedBy !== undefined ? [`| Claimed by (as given by the client; the forge does not vouch for it) | ${code(request.claimedBy)} |`] : []),
    `| Through | ${VIA[request.via]} |`,
    "",
  ];
  const names = Object.keys(request.inputs).sort();
  if (names.length > 0) {
    lines.push("| Input | Value |", "| --- | --- |");
    for (const name of names) lines.push(`| ${code(name)} | ${code(JSON.stringify(request.inputs[name]) ?? "null")} |`);
  } else {
    lines.push("The request gives no inputs; every input takes its default.");
  }
  const [, applied] = words.verbs.apply;
  const [, planned] = words.verbs.plan;
  lines.push(
    "",
    `Nothing was ${applied} or approved. This pull request only adds files; it is ${planned} like any other, and a person reviews and merges it.`,
    "",
  );
  const json = JSON.stringify(request, null, 2);
  const fence = fenceFor(json);
  lines.push(`${fence}json ${TEMPLATE_REQUEST_SCHEMA_ID}`, json, fence, "");
  return lines.join("\n");
}

/**
 * The request a pull request body carries: the first fenced block whose info
 * string is `json` and the template-request/v1 schema id, parsed and
 * checked against the schema. Undefined when the body has no such block, or
 * the block is not a valid request.
 */
export function parseRequestBody(body: string): TemplateRequest | undefined {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})json[ \t]+(\S+)[ \t]*$/.exec(lines[i]!);
    if (!open || open[2] !== TEMPLATE_REQUEST_SCHEMA_ID) continue;
    const fence = open[1]!;
    const end = lines.findIndex((l, j) => j > i && l.trimEnd() === fence);
    if (end < 0) return undefined;
    try {
      const doc: unknown = JSON.parse(lines.slice(i + 1, end).join("\n"));
      return validateTemplateRequest(doc).length === 0 ? (doc as TemplateRequest) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
