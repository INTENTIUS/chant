/**
 * The coverage table, as the two Markdown tables the docs page carries.
 *
 * Rendered from `./mapping.ts` rather than transcribed into the page by hand,
 * and `./coverage-doc.test.ts` asserts the page still matches. A coverage
 * table's whole value is that it is current, and a hand-copied one stops being
 * current the first time somebody adds a row and does not open the docs.
 */

import { DECLARED_UNMAPPED, ENGINE_KINDS_BY_ENTITY_TYPE } from "./mapping";

/** Markdown-safe: a pipe inside a cell would end the column. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

const byType = (a: [string, unknown], b: [string, unknown]): number => a[0].localeCompare(b[0]);

/** The mapped half: which entity types reach the engine, and as what. */
export function mappedMarkdown(): string {
  const rows = Object.entries(ENGINE_KINDS_BY_ENTITY_TYPE)
    .sort(byType)
    .map(
      ([type, m]) =>
        `| \`${cell(type)}\` | ${m.kind} | ${m.provider} | ${m.sizeProp ? `\`${cell(m.sizeProp)}\`` : "—"} | ${
          m.regionProp ? `\`${cell(m.regionProp)}\`, else the request's` : "the request's"
        } |`,
    );
  return ["| Entity type | Engine kind | Provider | Size read from | Region |", "|---|---|---|---|---|", ...rows].join("\n");
}

/** The declared-unmapped half: what augur will not send, and why. */
export function unmappedMarkdown(): string {
  const rows = Object.entries(DECLARED_UNMAPPED)
    .sort(byType)
    .map(([type, reason]) => `| \`${cell(type)}\` | ${cell(reason)} |`);
  return ["| Entity type | Why it carries no rate |", "|---|---|", ...rows].join("\n");
}

/** Both, for the generator that writes the docs page. */
export function coverageMarkdown(): string {
  return `${mappedMarkdown()}\n\n${unmappedMarkdown()}\n`;
}
