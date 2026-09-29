/**
 * Rule groups embedded in another lexicon's resource, for `chant import`
 * (#2962): a k8s `PrometheusRule`'s `spec.groups`, or a rule file held as
 * text in a ConfigMap.
 *
 * The groups are imported exactly as `chant import rules.yml` would import
 * them, into a directory of its own. `spec.groups` becomes the list of the
 * declared groups (an `Slo`'s by its `rules` member), which the k8s
 * serializer renders as the same groups; a rule file becomes
 * `ruleFileYaml([...])`, the text the prometheus serializer writes.
 */

import type { EmbeddedContentImporter, EmbeddedImport } from "@intentius/chant/import/embedded";
import { looksLikeRuleFile } from "../model";
import { parsePrometheusYaml } from "./parser";
import { generateRuleFile } from "./generator";

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
