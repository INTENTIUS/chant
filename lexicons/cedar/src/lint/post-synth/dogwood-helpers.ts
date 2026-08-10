/**
 * Turning a build's emitted files into `dogwood` CLI invocations (#1659).
 *
 * The DWDE checks both need the same thing: which of the emitted `.dw` files
 * is a policy set, which is a macro library, which `.cedarschema` backs
 * `--policy-schema`, and which `.dwschema` backs `--event-schema`. Planning
 * that once here keeps the two checks from disagreeing about what they ran —
 * DWDE010 validates a bundle and DWDE011 lowers the *same* bundle, and a
 * finding from one that names different inputs than the other would be a
 * puzzle rather than a report.
 *
 * Excluded from check auto-discovery by the "helper" filename filter.
 */
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { blankComments, dogwoodPolicyFiles, dogwoodSchemaFiles, type DogwoodArtifact } from "../../dogwood/scan";
import type { DogwoodBundle } from "../../dogwood/cli";

/** One planned invocation: the files, and the names to blame in a finding. */
export interface PreparedBundle {
  lexicon: string;
  /** The `.dw` policy set filename. */
  source: string;
  /** The `.cedarschema` filename passed as `--policy-schema`. */
  policySchemaSource: string;
  /** The `.dwschema` filename passed as `--event-schema`, when one was emitted. */
  eventSchemaSource?: string;
  bundle: DogwoodBundle;
}

/** What the CLI-gated checks should do with this build. */
export interface DogwoodRunPlan {
  /** True when the build emitted a `.dw` policy set at all. */
  hasPolicies: boolean;
  /** Every invocation to make. Empty when {@link blocked} is set. */
  bundles: PreparedBundle[];
  /** Why nothing can be run, when policies exist but a required input does not. */
  blocked?: string;
  /** The lexicon the `.dw` output came from, for a finding that names no file. */
  lexicon?: string;
}

/**
 * A `.dw` file holding only `def` declarations is a macro library, not a
 * policy set.
 *
 * By structure rather than by filename: the serializer's default is
 * `macros.dw`, but `MacroLibraryProps.filename` overrides it, and `chant
 * audit` runs over trees chant never wrote. A policy set is a file with a
 * `permit` or `forbid` head in it — upstream's policy grammar has no third
 * effect — and a set with inlined macros still has one.
 */
export function looksLikeMacroLibrary(text: string): boolean {
  return !/\b(permit|forbid)\s*\(/.test(blankComments(text));
}

function byName(a: DogwoodArtifact, b: DogwoodArtifact): number {
  return a.source.localeCompare(b.source);
}

/**
 * The Cedar action schema the CLI needs, as text.
 *
 * `--policy-schema` reads a human-readable `.cedarschema`; a `.cedarschema.json`
 * is not a substitute, so it is not offered as one. Sorted by filename so a
 * build emitting several picks the same one on every run.
 */
function findPolicySchema(ctx: PostSynthContext): DogwoodArtifact | undefined {
  const found: DogwoodArtifact[] = [];
  for (const [lexicon, output] of ctx.outputs) {
    if (typeof output === "string") continue;
    for (const [source, text] of Object.entries(output.files ?? {})) {
      if (typeof text !== "string") continue;
      if (!source.endsWith(".cedarschema")) continue;
      found.push({ lexicon, source, text });
    }
  }
  return found.sort(byName)[0];
}

/**
 * Plan every `dogwood` invocation this build calls for.
 *
 * One bundle per policy set per emitted event schema. A build with several
 * `.dwschema` files means several services, and `--event-schema` takes exactly
 * one file, so the set is run against each and every finding names the schema
 * it was found under — the alternative is picking one silently and reporting
 * against a schema the reader did not choose. Macro libraries do combine: a
 * library is a sequence of `def`s, so several concatenate into the one file
 * `--macros` accepts.
 */
export function planDogwoodRuns(ctx: PostSynthContext): DogwoodRunPlan {
  const files = dogwoodPolicyFiles(ctx).sort(byName);
  const policySets = files.filter((f) => !looksLikeMacroLibrary(f.text));
  if (policySets.length === 0) return { hasPolicies: false, bundles: [] };

  const lexicon = policySets[0].lexicon;
  const libraries = files.filter((f) => looksLikeMacroLibrary(f.text));
  const macros = libraries.length > 0 ? libraries.map((f) => f.text).join("\n") : undefined;

  const policySchema = findPolicySchema(ctx);
  if (!policySchema) {
    return {
      hasPolicies: true,
      bundles: [],
      lexicon,
      blocked:
        "no Cedar action schema (.cedarschema) was emitted beside them, and `dogwood validate` requires one via --policy-schema",
    };
  }

  const eventSchemas = dogwoodSchemaFiles(ctx).sort(byName);
  const bundles: PreparedBundle[] = [];

  for (const set of policySets) {
    for (const events of eventSchemas.length > 0 ? eventSchemas : [undefined]) {
      bundles.push({
        lexicon: set.lexicon,
        source: set.source,
        policySchemaSource: policySchema.source,
        ...(events ? { eventSchemaSource: events.source } : {}),
        bundle: {
          policies: set.text,
          policySchema: policySchema.text,
          ...(events ? { eventSchema: events.text } : {}),
          ...(macros !== undefined ? { macros } : {}),
        },
      });
    }
  }

  return { hasPolicies: true, bundles, lexicon };
}

/** How a finding names the inputs a run was made with. */
export function describeBundle(prepared: PreparedBundle): string {
  const parts = [`"${prepared.source}"`, `against "${prepared.policySchemaSource}"`];
  if (prepared.eventSchemaSource) parts.push(`with "${prepared.eventSchemaSource}"`);
  return parts.join(" ");
}
