/**
 * WFW111: Unknown Key Detection
 *
 * Detects keys in the generated TOML output that are not recognized as
 * valid Flyway properties. Unknown keys are silently ignored by Flyway,
 * which usually indicates a typo or misconfiguration.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, forEachEnvironment, getFlywaySection } from "./flyway-helpers";
import { VALID_KEYS_BY_TOML_SECTION } from "../../properties";

function checkKeys(
  keys: string[],
  validKeys: Set<string>,
  section: string,
  entity: string,
  diagnostics: PostSynthDiagnostic[],
): void {
  for (const key of keys) {
    if (!validKeys.has(key)) {
      diagnostics.push({
        checkId: "WFW111",
        severity: "warning",
        message: `Unknown key "${key}" in ${section} — this key is not a recognized Flyway property and will be ignored`,
        entity,
        lexicon: "flyway",
      });
    }
  }
}

export const wfw111: PostSynthCheck = {
  id: "WFW111",
  description: "Unknown key in TOML output — key is not a recognized Flyway property",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);

      // Check root-level keys (FlywayProject properties + known sections)
      const rootValidKeys = VALID_KEYS_BY_TOML_SECTION.root;
      const knownSections = new Set(["flyway", "environments", "flywayDesktop", "redgateCompare"]);
      const rootKeys = Object.keys(config).filter(
        (k) => !knownSections.has(k),
      );
      checkKeys(rootKeys, rootValidKeys, "[root]", name, diagnostics);

      // Check [flyway] section
      const flywaySection = getFlywaySection(config);
      if (flywaySection) {
        const flywayValidKeys = VALID_KEYS_BY_TOML_SECTION.flyway;
        checkKeys(Object.keys(flywaySection), flywayValidKeys, "[flyway]", name, diagnostics);
      }

      // Check [environments.*] sections
      const envValidKeys = VALID_KEYS_BY_TOML_SECTION.environments;
      forEachEnvironment(config, (envName, env) => {
        checkKeys(
          Object.keys(env),
          envValidKeys,
          `[environments.${envName}]`,
          name,
          diagnostics,
        );
      });

      // Check [flywayDesktop] section
      const desktop = config.flywayDesktop;
      if (desktop && typeof desktop === "object") {
        const desktopValidKeys = VALID_KEYS_BY_TOML_SECTION.flywayDesktop;
        checkKeys(Object.keys(desktop), desktopValidKeys, "[flywayDesktop]", name, diagnostics);
      }

      // Check [redgateCompare] section
      const redgate = config.redgateCompare;
      if (redgate && typeof redgate === "object") {
        const redgateValidKeys = VALID_KEYS_BY_TOML_SECTION.redgateCompare;
        checkKeys(Object.keys(redgate), redgateValidKeys, "[redgateCompare]", name, diagnostics);
      }
    }

    return diagnostics;
  },
};
