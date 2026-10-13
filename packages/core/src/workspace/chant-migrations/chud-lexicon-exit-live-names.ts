/**
 * `chud-lexicon-exit-live-names` (#2833): join the migrated `app` component
 * to the Machine its release Op ships to, so `chant components status --live`
 * reads it reconciled instead of stale.
 *
 * `chud-lexicon-exit` (0.92.0) rewrote `deploy/app.component.ts` off chud's
 * app component, and wrote no `liveNames` on it. `components status --live`
 * joins a component to live entities by name (`Component.liveNames`, falling
 * back to the component's own name), and the component is `app` while the
 * Machine the release Op ships to is some other entity. With no `liveNames`,
 * the identity fallback looks for an entity named `app`, finds none, and the
 * status reads `stale` even right after a release.
 *
 * This migration adds `liveNames: [<name>]` to the app component chant
 * wrote, deriving `<name>` from what the member's Fly resources actually
 * declare (#2839) rather than assuming one: while `deploy/fly-machine.ts`
 * still declares the Machine directly, it is the entity `server`, its own
 * top-level export. Once chant#2809's `FlySite` migration has taken over
 * (deploy/fly.ts declares the site with the fly lexicon's `FlySite`
 * composite and `fly-machine.ts` is gone), the composite expands its
 * `machine` member under the site's own instance name, so the Machine is
 * `<instance>Machine` — `flySiteMachine` for the instance name the FlySite
 * migration writes (`flySite`), but read from the file rather than assumed,
 * since a person may rename the export. The two migrations run in registry
 * order (`FlySite` first), so a fresh upgrade that takes both always sees the
 * post-`FlySite` shape by the time this one plans.
 *
 * It looks for the component `chud-lexicon-exit` left (by its own comment and
 * shape) and inserts the field after `dependsOn: [],` rather than next to
 * `archetype` — chant#2809's `FlySite` migration recognises the component by
 * the exact, contiguous text `archetype: "service",\n  dependsOn: [],\n`, so
 * anything inserted between those two lines (by either migration, in either
 * order) would stop it from finding a component whose `composites` a person
 * later removes. Anchoring after `dependsOn` instead keeps that pair intact
 * whichever of the two migrations plans first.
 *
 * The plan is empty once `liveNames` already names the Machine this would
 * derive. A component whose `liveNames` is exactly `["server"]` — this
 * migration's own hardcoded output before #2839 — is corrected once the
 * Machine it names is gone (`FlySite` has since taken over); any other
 * hand-set value is left alone, on the same "by any hand" rule the empty
 * case follows. It is a conflict when the component still reads as
 * chud-lexicon-exit's but the `dependsOn: [],` line the edit anchors on is
 * gone, or neither `deploy/fly.ts` nor `deploy/fly-machine.ts` says what the
 * Machine's live name is — either way a person needs to add the mapping by
 * hand.
 */

import { posix } from "node:path";
import type { ChantMigration, ChantMigrationContext, ChantMigrationPlan, PlanConflict, PlannedChange } from "../chant-migrations";
import { applyEdits, readText, CHUD_LEXICON_EXIT, type Edit } from "./chud-lexicon-exit";

export const CHUD_LEXICON_EXIT_LIVE_NAMES = "chud-lexicon-exit-live-names";

const DESCRIPTION = "join the app component to the Machine its release Op ships to, so components status --live reads it (#2833)";

/** The app component `chud-lexicon-exit` writes, recognised by its own comment and shape (composites or not, ws-056's FlySite migration may have added one). */
function isExitAppComponent(text: string): boolean {
  return text.includes("wrote this from chud's app component") && text.includes(`migration ${CHUD_LEXICON_EXIT}`) && /name:\s*"app"/.test(text);
}

/** This migration's own hardcoded output before #2839, worth correcting once the Machine it names no longer exists. */
const BAD_DEFAULT = 'liveNames: ["server"]';

/**
 * The live name of the Machine the member's release Op ships to, derived
 * from what `deploy/fly.ts` and `deploy/fly-machine.ts` actually declare
 * (#2839): `<instance>Machine`, from the export name a `FlySite` composite
 * instance is declared under, once chant#2809's migration has taken over; the
 * entity `server`, `fly-machine.ts`'s own top-level export, while that file
 * still declares the Machine directly. Neither shape: null, so the caller
 * leaves it to a person rather than guessing.
 */
function machineLiveName(dir: string, memberDir: string): string | null {
  const fly = readText(dir, posix.join(memberDir, "deploy/fly.ts"));
  const instance = fly !== undefined ? /^export const (\w+) = FlySite\(/m.exec(fly)?.[1] : undefined;
  if (instance) return `${instance}Machine`;
  if (readText(dir, posix.join(memberDir, "deploy/fly-machine.ts")) !== undefined) return "server";
  return null;
}

function liveNamesEdits(name: string): Edit[] {
  return [
    {
      find: /dependsOn: \[\],\n/,
      replace: `dependsOn: [],\n  liveNames: ["${name}"],\n`,
      required: "the dependsOn: [] line",
    },
    {
      // Best-effort: names the Machine in the component's own doc comment, when
      // it still reads as chud-lexicon-exit left it. Not required — an edited
      // comment is left alone. The caller only reaches this when the component
      // has no liveNames yet, so this never double-fires.
      find: " * records no release. The local site is the studio kit's box service\n * (arugula-salad/studio, template/), and the Fly site's resources stay in\n * fly.ts and fly-machine.ts.\n",
      replace:
        " * records no release. The local site is the studio kit's box service\n" +
        " * (arugula-salad/studio, template/), and the Fly site's resources stay in\n" +
        " * fly.ts and fly-machine.ts. Its live name is the Machine the release Op\n" +
        ` * ships to, the entity ${name} (chant#2833), which\n` +
        " * `chant components status --live` observes for it.\n",
    },
  ];
}

interface Declaration {
  members?: Array<{ dir?: string; kind?: string }>;
}

function planLiveNames(ctx: ChantMigrationContext): ChantMigrationPlan | null {
  const { dir } = ctx;
  let decl: Declaration | null = null;
  try {
    decl = JSON.parse(readText(dir, "chant.workspace.json") ?? "null") as Declaration | null;
  } catch {
    decl = null;
  }
  const candidates = (decl?.members ?? []).filter((m) => m.kind === "chant" && m.dir).map((m) => posix.normalize(m.dir!));
  if (!candidates.includes("delivery")) candidates.push("delivery");

  const changes: PlannedChange[] = [];
  const conflicts: PlanConflict[] = [];
  for (const d of candidates) {
    const path = posix.join(d, "deploy/app.component.ts");
    const text = readText(dir, path);
    if (text === undefined || !isExitAppComponent(text)) continue;

    if (/liveNames:/.test(text)) {
      // Already there, by any hand: nothing to add. Correct it only when it
      // is exactly this migration's own bad default and the Machine it names
      // is gone — any other value, including the right one, is left alone.
      if (!text.includes(BAD_DEFAULT)) continue;
      const name = machineLiveName(dir, d);
      if (name === null || name === "server") continue;
      changes.push({
        path,
        action: "write",
        why: `liveNames: ["${name}"]: the app component joins the Machine the FlySite composite gives it now, in place of the entity this migration wrongly assumed (#2839)`,
        data: Buffer.from(text.replace(BAD_DEFAULT, `liveNames: ["${name}"]`)),
      });
      continue;
    }

    const name = machineLiveName(dir, d);
    if (name === null) {
      conflicts.push({ path, reason: "cannot tell the Machine's live name from deploy/fly.ts or deploy/fly-machine.ts. Add liveNames to the app component by hand, then run the upgrade again" });
      continue;
    }
    const edited = applyEdits(text, liveNamesEdits(name));
    if (edited.missing.length > 0) {
      conflicts.push({ path, reason: `cannot find ${edited.missing.join("; ")}. Add liveNames: ["${name}"] to the app component by hand, then run the upgrade again` });
      continue;
    }
    if (edited.text === text) continue;
    changes.push({ path, action: "write", why: `liveNames: ["${name}"]: the app component joins the Machine its release Op ships to`, data: Buffer.from(edited.text) });
  }
  if (changes.length === 0 && conflicts.length === 0) return null;
  return { id: CHUD_LEXICON_EXIT_LIVE_NAMES, description: DESCRIPTION, changes, notMoved: [], conflicts };
}

export const chudLexiconExitLiveNames: ChantMigration = {
  id: CHUD_LEXICON_EXIT_LIVE_NAMES,
  description: DESCRIPTION,
  plan: planLiveNames,
};
