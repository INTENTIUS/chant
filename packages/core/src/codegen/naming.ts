/**
 * Collision-free naming strategy for TypeScript class names.
 *
 * 6-phase algorithm:
 * 1. Priority names (backward compatibility)
 * 1a. Reserved names — names this lexicon has already published (chant #1459)
 * 2. Priority aliases (additional short names)
 * 3. Short names (last segment of type)
 * 4. Collision resolution (service-prefixed)
 * 5. Property type aliases (globally unique defs)
 *
 * ## Why phase 1a exists
 *
 * Phases 3 and 4 assign a short name to whoever asks first and service-qualify
 * everyone after. Membership of that contest is the whole input set, so a
 * resource's name was a function of its NEIGHBOURS: removing
 * `AWS::Athena::Session` upstream freed `Session`, and `AWS::Macie::Session`
 * silently changed from `MacieSession` to `Session` — a breaking rename for a
 * resource whose schema had not moved. Adding a resource does the same in
 * reverse: `AWS::QuickSight::Space` appearing renamed `AWS::SageMaker::Space`
 * from `Space` to `SageMakerSpace`.
 *
 * Worse, it is reversible. These are read-only registry types that come and go,
 * so a name could flip back on the next upgrade and break consumers again.
 *
 * Reserved names invert the bias: a name that has already shipped belongs to
 * the type that shipped it, and a newcomer colliding with it gets qualified
 * instead. A published name then changes only when its own type disappears,
 * which is a genuine breaking change rather than an incidental one.
 */

/**
 * Minimal input required by the naming strategy — avoids coupling
 * to any specific schema parser output format.
 */
export interface NamingInput {
  typeName: string;
  propertyTypes: Array<{ name: string }>;
}

/**
 * Configuration that parameterizes the naming algorithm.
 * The data tables and name-extraction helpers are provider-specific.
 */
export interface NamingConfig {
  /** Fixed TypeScript class names for backward compatibility. */
  priorityNames: Record<string, string>;
  /** Additional TypeScript names beyond the primary priority name. */
  priorityAliases: Record<string, string[]>;
  /** Property type aliases that must always be emitted. */
  priorityPropertyAliases: Record<string, Record<string, string>>;
  /** Service name abbreviations for collision-resolved names. */
  serviceAbbreviations: Record<string, string>;
  /** Extract the short name from a type name (e.g. "Vendor::Service::Resource" → "Resource"). */
  shortName: (typeName: string) => string;
  /** Extract the service name from a type name (e.g. "Vendor::Service::Resource" → "Service"). */
  serviceName: (typeName: string) => string;
  /**
   * chant #1459 — spec type name → the TypeScript name this lexicon has
   * already published for it, normally read from the committed
   * `surface.snapshot.json` via {@link reservedNamesFromSnapshot}.
   *
   * Claimed before short names are contested, so a shipped name is not taken
   * away from its owner by an unrelated upstream change. Omit for a lexicon
   * with no published surface yet; an entry for a type that is no longer in
   * the input is ignored, so a removed type frees its name for reuse.
   */
  reservedNames?: Record<string, string>;
}

/**
 * The names a lexicon has already published, read from a committed surface
 * snapshot (chant #1459).
 *
 * The snapshot is keyed by TypeScript name with the spec type inside, which is
 * exactly the mapping phase 1a needs, inverted. Only `resource` entries are
 * reserved: property-type names are derived from their owning resource's name
 * (phase 5), so pinning the resource pins them, and reserving them separately
 * would freeze aliases that are meant to follow their parent.
 */
export function reservedNamesFromSnapshot(
  snapshot: { entries?: Record<string, { kind?: string; resourceType?: string }> } | undefined,
): Record<string, string> {
  const reserved: Record<string, string> = {};
  for (const [tsName, entry] of Object.entries(snapshot?.entries ?? {})) {
    if (entry.kind !== "resource" || !entry.resourceType) continue;
    // First writer wins: a snapshot that somehow lists one spec type under two
    // names keeps the earlier, rather than silently preferring iteration order.
    reserved[entry.resourceType] ??= tsName;
  }
  return reserved;
}

export class NamingStrategy {
  private assigned = new Map<string, string>(); // typeName → primary TS name
  private _aliases = new Map<string, string[]>(); // typeName → additional TS names
  private usedNames = new Set<string>();
  private _propertyAliases = new Map<string, Map<string, string>>(); // typeName → (defName → aliasName)

  constructor(results: NamingInput[], private config: NamingConfig) {
    const typeNames = results.map((r) => r.typeName);

    const abbreviateService = (service: string): string =>
      config.serviceAbbreviations[service] ?? service;

    // Phase 1: assign priority names
    for (const t of typeNames) {
      const name = config.priorityNames[t];
      if (name) {
        this.assigned.set(t, name);
        this.usedNames.add(name);
      }
    }

    // Phase 1a: claim previously-published names (chant #1459).
    //
    // After priority names, which are explicit hand-pinned decisions and still
    // win, and before any short name is contested. A reserved name whose type
    // is gone from the input is simply never reached, so its name is released
    // for whoever legitimately claims it next.
    for (const t of typeNames) {
      if (this.assigned.has(t)) continue;
      const published = config.reservedNames?.[t];
      // `usedNames` guards the case where a priority name already took it —
      // an explicit pin outranks history.
      if (published && !this.usedNames.has(published)) {
        this.assigned.set(t, published);
        this.usedNames.add(published);
      }
    }

    // Phase 1b: assign priority aliases
    for (const t of typeNames) {
      const extras = config.priorityAliases[t];
      if (extras) {
        for (const alias of extras) {
          if (!this.usedNames.has(alias)) {
            const existing = this._aliases.get(t) ?? [];
            existing.push(alias);
            this._aliases.set(t, existing);
            this.usedNames.add(alias);
          }
        }
      }
    }

    // Phase 2: collect short names for non-priority types and detect collisions
    const shortNameUsers = new Map<string, string[]>(); // shortName → typeNames
    const nonPriority: string[] = [];

    for (const t of typeNames) {
      if (this.assigned.has(t)) continue;
      nonPriority.push(t);
      const short = config.shortName(t);
      const users = shortNameUsers.get(short) ?? [];
      users.push(t);
      shortNameUsers.set(short, users);
    }

    // Phase 3: assign non-colliding short names
    for (const [short, users] of shortNameUsers) {
      if (users.length === 1 && !this.usedNames.has(short)) {
        this.assigned.set(users[0], short);
        this.usedNames.add(short);
      }
    }

    // Phase 4: resolve collisions with service prefix
    for (const t of nonPriority) {
      if (this.assigned.has(t)) continue;
      const short = config.shortName(t);
      const service = abbreviateService(config.serviceName(t));
      const prefixed = service + short;
      this.assigned.set(t, prefixed);
      this.usedNames.add(prefixed);
    }

    // Phase 5: compute property type aliases
    // First, force priority property aliases
    for (const [typeName, aliases] of Object.entries(config.priorityPropertyAliases)) {
      if (!this.assigned.has(typeName)) continue;
      for (const [defName, aliasName] of Object.entries(aliases)) {
        if (!this.usedNames.has(aliasName)) {
          let ptAliases = this._propertyAliases.get(typeName);
          if (!ptAliases) {
            ptAliases = new Map();
            this._propertyAliases.set(typeName, ptAliases);
          }
          ptAliases.set(defName, aliasName);
          this.usedNames.add(aliasName);
        }
      }
    }

    // Count how many resources define each property type defName
    const defNameCount = new Map<string, number>();
    for (const r of results) {
      const shortName = config.shortName(r.typeName);
      for (const pt of r.propertyTypes) {
        const defName = extractDefName(pt.name, shortName);
        defNameCount.set(defName, (defNameCount.get(defName) ?? 0) + 1);
      }
    }

    // For globally unique defNames, create an alias
    for (const r of results) {
      const typeName = r.typeName;
      const tsName = this.assigned.get(typeName);
      if (!tsName) continue;
      const shortName = config.shortName(typeName);

      for (const pt of r.propertyTypes) {
        const defName = extractDefName(pt.name, shortName);
        if (defNameCount.get(defName) === 1 && !this.usedNames.has(defName)) {
          let ptAliases = this._propertyAliases.get(typeName);
          if (!ptAliases) {
            ptAliases = new Map();
            this._propertyAliases.set(typeName, ptAliases);
          }
          ptAliases.set(defName, defName);
          this.usedNames.add(defName);
        }
      }
    }
  }

  /** Primary TypeScript class name for a type. */
  resolve(typeName: string): string | undefined {
    return this.assigned.get(typeName);
  }

  /** Additional TypeScript names for a type. */
  aliases(typeName: string): string[] {
    return this._aliases.get(typeName) ?? [];
  }

  /** All (typeName, tsName) pairs sorted by TS name. */
  allAssignments(): [string, string][] {
    const pairs: [string, string][] = [];
    for (const [t, name] of this.assigned) {
      pairs.push([t, name]);
    }
    for (const [t, extras] of this._aliases) {
      for (const alias of extras) {
        pairs.push([t, alias]);
      }
    }
    pairs.sort((a, b) => a[1].localeCompare(b[1]));
    return pairs;
  }

  /** Property type aliases for a given type. */
  propertyTypeAliases(typeName: string): Map<string, string> | undefined {
    return this._propertyAliases.get(typeName);
  }
}

/**
 * Construct property type name: "Bucket_ServerSideEncryptionByDefault"
 */
export function propertyTypeName(parentTSName: string, defName: string): string {
  return `${parentTSName}_${defName}`;
}

/**
 * Extract the raw definition name from a parser-generated name.
 * "Bucket_ServerSideEncryptionByDefault" → "ServerSideEncryptionByDefault"
 */
export function extractDefName(parserName: string, shortName: string): string {
  const prefix = `${shortName}_`;
  return parserName.startsWith(prefix) ? parserName.slice(prefix.length) : parserName;
}
