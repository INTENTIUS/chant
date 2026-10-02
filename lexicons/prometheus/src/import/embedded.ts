/**
 * Prometheus and Alertmanager content embedded in another lexicon's
 * resource, for `chant import`: a k8s `PrometheusRule`'s `spec.groups`, or a
 * rule file held as text in a ConfigMap (#2962), and an `alertmanager.yml`
 * held as text in a ConfigMap (#3031).
 *
 * The groups are imported exactly as `chant import rules.yml` would import
 * them, into a directory of its own. `spec.groups` becomes the list of the
 * declared groups (an `Slo`'s by its `rules` member), which the k8s
 * serializer renders as the same groups; a rule file becomes
 * `ruleFileYaml([...])`, the text the prometheus serializer writes.
 *
 * An `alertmanager.yml` is imported exactly as `chant import alertmanager.yml`
 * would import it, and becomes `alertmanagerYaml([...])` over every receiver,
 * time interval, root route, inhibit rule and settings it declares. The
 * ConfigMap then holds the config as the serializer writes it: the same
 * config, with Alertmanager's deprecated spellings rewritten as the
 * standalone import rewrites them.
 */

import type { EmbeddedContentImporter, EmbeddedImport } from "@intentius/chant/import/embedded";
import { looksLikeAlertmanagerConfig, looksLikeRuleFile } from "../model";
import { parsePrometheusYaml } from "./parser";
import { generateAlertmanager, generateRuleFile } from "./generator";

const PACKAGE = "@intentius/chant-lexicon-prometheus";

export const ruleGroupsImporter: EmbeddedContentImporter = {
  what: "Prometheus rule groups",

  matches(content) {
    if (!looksLikeRuleFile(content.document)) return false;
    return content.select === "groups" || (content.select === undefined && typeof content.text === "string");
  },

  import(content): EmbeddedImport {
    // JSON is YAML: the document goes through the same parser a rule file does.
    const source = content.select === undefined ? content.text! : JSON.stringify(content.document);
    const parsed = parsePrometheusYaml(source);
    if (parsed.kind !== "rules") throw new Error("this is not a Prometheus rule file");
    const { files, groups } = generateRuleFile(parsed.file);
    const bindings = groups.map((g) => ({ from: g.path, name: g.name, ...(g.member ? { member: g.member } : {}) }));
    return {
      files,
      value:
        content.select === undefined
          ? { bindings, shape: "list", through: { from: PACKAGE, name: "ruleFileYaml" } }
          : { bindings, shape: "list" },
      warnings: parsed.warnings,
    };
  },
};

export const alertmanagerImporter: EmbeddedContentImporter = {
  what: "an Alertmanager config",

  matches(content) {
    return content.select === undefined && typeof content.text === "string" && looksLikeAlertmanagerConfig(content.document);
  },

  import(content): EmbeddedImport {
    const parsed = parsePrometheusYaml(content.text!);
    if (parsed.kind !== "alertmanager") throw new Error("this is not an alertmanager.yml");
    const { files, declarations } = generateAlertmanager(parsed.config);
    if (declarations.length === 0) throw new Error("the import declared nothing");
    return {
      files,
      value: {
        bindings: declarations.map((d) => ({ from: d.path, name: d.name })),
        shape: "list",
        through: { from: PACKAGE, name: "alertmanagerYaml" },
      },
      warnings: parsed.warnings,
    };
  },
};
