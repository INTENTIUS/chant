/**
 * The coverage table, as the two Markdown tables the docs page carries.
 *
 * Rendered from `./mapping.ts` rather than transcribed into the page by hand,
 * and `./coverage-doc.test.ts` asserts the page still matches. A coverage
 * table's whole value is that it is current, and a hand-copied one stops being
 * current the first time somebody adds a row and does not open the docs.
 */

import {
  byCodeUnit,
  DECLARED_UNMAPPED,
  DECLARED_UNMAPPED_TERRAFORM,
  ENGINE_KINDS_BY_ENTITY_TYPE,
  ENGINE_KINDS_BY_TERRAFORM_TYPE,
  type EngineKindMapping,
} from "./mapping";

/** Markdown-safe: a pipe inside a cell would end the column. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

// By code unit. The rendered tables are compared against the committed docs
// page, so a locale-dependent order turns that check into a coin flip on a
// contributor machine whose `LANG` differs from CI's.
const byType = (a: [string, unknown], b: [string, unknown]): number => byCodeUnit(a[0], b[0]);

function mappedTable(table: Readonly<Record<string, EngineKindMapping>>, column: string): string {
  const rows = Object.entries(table)
    .sort(byType)
    .map(
      ([type, m]) =>
        `| \`${cell(type)}\` | ${m.kind} | ${m.provider} | ${m.sizeProp ? `\`${cell(m.sizeProp)}\`` : "—"} | ${
          m.regionProp ? `\`${cell(m.regionProp)}\`, else the request's` : "the request's"
        } |`,
    );
  return [`| ${column} | Engine kind | Provider | Size read from | Region |`, "|---|---|---|---|---|", ...rows].join("\n");
}

function unmappedTable(table: Readonly<Record<string, string>>, column: string): string {
  const rows = Object.entries(table)
    .sort(byType)
    .map(([type, reason]) => `| \`${cell(type)}\` | ${cell(reason)} |`);
  return [`| ${column} | Why it carries no rate |`, "|---|---|", ...rows].join("\n");
}

/** The mapped half: which entity types reach the engine, and as what. */
export function mappedMarkdown(): string {
  return mappedTable(ENGINE_KINDS_BY_ENTITY_TYPE, "Entity type");
}

/** The declared-unmapped half: what augur will not send, and why. */
export function unmappedMarkdown(): string {
  return unmappedTable(DECLARED_UNMAPPED, "Entity type");
}

/** The terraform half's mapped rows, keyed by provider type (#2360). */
export function terraformMappedMarkdown(): string {
  return mappedTable(ENGINE_KINDS_BY_TERRAFORM_TYPE, "Provider type");
}

/** The terraform half's declared-unmapped rows. */
export function terraformUnmappedMarkdown(): string {
  return unmappedTable(DECLARED_UNMAPPED_TERRAFORM, "Provider type");
}

/** All four, for the generator that writes the docs page. */
export function coverageMarkdown(): string {
  return `${mappedMarkdown()}\n\n${unmappedMarkdown()}\n\n${terraformMappedMarkdown()}\n\n${terraformUnmappedMarkdown()}\n`;
}
