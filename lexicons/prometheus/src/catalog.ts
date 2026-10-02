/**
 * The entity catalog: every class this package exports, keyed by class name.
 * It feeds the packaged registry (`dist/meta.json`), LSP completions and
 * hover, and the docs.
 */

import type { LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { RULE_GROUP_TYPE } from "./rules";
import { INHIBIT_RULE_TYPE, RECEIVER_TYPE, ROUTE_TYPE, SETTINGS_TYPE, TIME_INTERVAL_TYPE } from "./alertmanager";

export interface CatalogEntry {
  className: string;
  entityType: string;
  /** The file the entity serializes into. */
  file: "rule file" | "alertmanager.yml";
  description: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    className: "RuleGroup",
    entityType: RULE_GROUP_TYPE,
    file: "rule file",
    description: "A group of recording and alerting rules, evaluated together on one interval",
  },
  {
    className: "Route",
    entityType: ROUTE_TYPE,
    file: "alertmanager.yml",
    description: "A node in Alertmanager's routing tree: matchers, grouping and timing, and the receiver alerts go to",
  },
  {
    className: "Receiver",
    entityType: RECEIVER_TYPE,
    file: "alertmanager.yml",
    description: "A notification receiver with webhook, email, Slack and PagerDuty integrations",
  },
  {
    className: "InhibitRule",
    entityType: INHIBIT_RULE_TYPE,
    file: "alertmanager.yml",
    description: "Mutes alerts matching target_matchers while an alert matching source_matchers fires",
  },
  {
    className: "TimeInterval",
    entityType: TIME_INTERVAL_TYPE,
    file: "alertmanager.yml",
    description: "A named set of time periods a route can mute or activate on",
  },
  {
    className: "AlertmanagerSettings",
    entityType: SETTINGS_TYPE,
    file: "alertmanager.yml",
    description: "The global block (SMTP, Slack and PagerDuty defaults, resolve_timeout) and the templates list",
  },
];

/** The catalog as a chant lexicon registry, keyed by class name. */
export function lexiconRegistry(): Record<string, LexiconEntry> {
  const out: Record<string, LexiconEntry> = {};
  for (const e of [...CATALOG].sort((a, b) => a.className.localeCompare(b.className))) {
    out[e.className] = { resourceType: e.entityType, kind: "resource", lexicon: "prometheus" };
  }
  return out;
}
