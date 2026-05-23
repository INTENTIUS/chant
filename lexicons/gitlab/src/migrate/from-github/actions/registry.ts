/**
 * ActionMapping registry for GitHub Actions → GitLab CI translation.
 *
 * Each marketplace action gets a typed mapping that returns the GitLab-side
 * effects (script lines, image substitution, services, cache, artifacts,
 * job-level variables) plus provenance records.
 *
 * v1 ships a built-in registry covering 33 actions (Tier 1/2/3, see
 * `tier-1.ts`/`tier-2.ts`/`tier-3.ts`). Users can inject their own
 * mappings via `MigrateOptions.registry`.
 */

import type { ProvenanceRecord } from "../provenance";

export interface ActionMapCtx {
  /** GitLab IR job logicalId */
  logicalId: string;
  /** Original GitHub job name (kebab-case) */
  jobName: string;
  /** Source file (for provenance) */
  sourceFile?: string;
  /** 0-based step index within the job */
  stepIndex: number;
}

export interface ActionMappedResult {
  /** Lines appended to the GitLab job `script:` */
  scriptLines: string[];
  /** Lines prepended to the GitLab job `before_script:` */
  beforeScript?: string[];
  /** Job-level image override (last write wins) */
  image?: string;
  /** Job-level services to add */
  services?: unknown[];
  /** Job-level cache config */
  cache?: Record<string, unknown>;
  /** Job-level artifacts config */
  artifacts?: Record<string, unknown>;
  /** Job-level variables to merge */
  variables?: Record<string, unknown>;
  /** Provenance records for this mapping firing */
  provenance: ProvenanceRecord[];
}

export interface ActionMapping {
  /** Action name without version, e.g. "actions/checkout" */
  actionName: string;
  /** Optional version filter (matches against major version) */
  majorVersions?: string[];
  /** Tier (1: must-have, 2: common, 3: niche) */
  tier: 1 | 2 | 3;
  /** Apply the mapping to a step */
  translate(step: Record<string, unknown>, ctx: ActionMapCtx): ActionMappedResult;
}

export interface ActionMappingRegistry {
  register(mapping: ActionMapping): void;
  lookup(actionRef: string): ActionMapping | undefined;
}

class DefaultRegistry implements ActionMappingRegistry {
  private byName = new Map<string, ActionMapping[]>();

  register(mapping: ActionMapping): void {
    const arr = this.byName.get(mapping.actionName) ?? [];
    arr.push(mapping);
    this.byName.set(mapping.actionName, arr);
  }

  lookup(actionRef: string): ActionMapping | undefined {
    // actionRef is e.g. "actions/checkout@v4" or "docker/build-push-action@v5"
    const [name, version] = actionRef.split("@");
    const candidates = this.byName.get(name);
    if (!candidates || candidates.length === 0) return undefined;
    if (!version) return candidates[0];
    // Find a mapping whose majorVersions includes this version (best effort)
    const major = version.replace(/^v/, "").split(".")[0];
    for (const c of candidates) {
      if (!c.majorVersions || c.majorVersions.length === 0) return c;
      if (c.majorVersions.includes(`v${major}`) || c.majorVersions.includes(major)) {
        return c;
      }
    }
    // No version match — fall back to first registered
    return candidates[0];
  }
}

let defaultRegistryInstance: ActionMappingRegistry | undefined;

export function getDefaultRegistry(): ActionMappingRegistry {
  if (!defaultRegistryInstance) {
    defaultRegistryInstance = new DefaultRegistry();
  }
  return defaultRegistryInstance;
}

/**
 * Test-only: replace the default registry. Used by `lookupAction` callers
 * that pass `opts.registry` to inject a stub. Reset to undefined to restore.
 */
export function setDefaultRegistry(registry: ActionMappingRegistry | undefined): void {
  defaultRegistryInstance = registry;
}

export function createRegistry(): ActionMappingRegistry {
  return new DefaultRegistry();
}

export function lookupAction(actionRef: string, registry?: ActionMappingRegistry): ActionMapping | undefined {
  return (registry ?? getDefaultRegistry()).lookup(actionRef);
}
