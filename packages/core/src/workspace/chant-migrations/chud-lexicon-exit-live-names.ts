/**
 * `chud-lexicon-exit-live-names` (#2833): join the migrated `app` component
 * to the Machine its release Op ships to, so `chant components status --live`
 * reads it reconciled instead of stale.
 *
 * `chud-lexicon-exit` (0.92.0) rewrote `deploy/app.component.ts` off chud's
 * app component, and wrote no `liveNames` on it. `components status --live`
 * joins a component to live entities by name (`Component.liveNames`, falling
 * back to the component's own name), and the component is `app` while the
 * Machine the release Op ships to (`deploy/fly-machine.ts`) is the entity
 * `server` (its Machine name, `web`, is a Fly attribute and not the entity
 * chant's graph knows it by). With no `liveNames`, the identity fallback
 * looks for an entity named `app`, finds none, and the status reads `stale`
 * even right after a release.
 *
 * This migration adds `liveNames: ["server"]` to the app component chant
 * wrote. It looks for the component `chud-lexicon-exit` left (by its own
 * comment and shape) and inserts the field after `dependsOn: [],` rather than
 * next to `archetype` — chant#2809's `FlySite` migration recognises the
 * component by the exact, contiguous text `archetype: "service",\n
 * dependsOn: [],\n`, so anything inserted between those two lines (by either
 * migration, in either order) would stop it from finding a component whose
 * `composites` a person later removes. Anchoring after `dependsOn` instead
 * keeps that pair intact whichever of the two migrations plans first.
 *
 * The plan is empty once `liveNames` is already there (by any hand), and it
 * is a conflict when the component still reads as chud-lexicon-exit's but the
 * `dependsOn: [],` line the edit anchors on is gone — a component so
 * rewritten needs a person to add the mapping by hand.
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

export const APP_COMPONENT_LIVE_NAMES_EDITS: Edit[] = [
  {
    find: /dependsOn: \[\],\n/,
    replace: 'dependsOn: [],\n  liveNames: ["server"],\n',
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
      " * ships to, the entity fly-machine.ts calls server (chant#2833), which\n" +
      " * `chant components status --live` observes for it.\n",
  },
];

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
    // Already has one, by any hand: nothing to add, and no reason to touch
    // the comment either.
    if (/liveNames:/.test(text)) continue;
    const edited = applyEdits(text, APP_COMPONENT_LIVE_NAMES_EDITS);
    if (edited.missing.length > 0) {
      conflicts.push({ path, reason: `cannot find ${edited.missing.join("; ")}. Add liveNames: ["server"] to the app component by hand, then run the upgrade again` });
      continue;
    }
    if (edited.text === text) continue;
    changes.push({ path, action: "write", why: 'liveNames: ["server"]: the app component joins the Machine its release Op ships to', data: Buffer.from(edited.text) });
  }
  if (changes.length === 0 && conflicts.length === 0) return null;
  return { id: CHUD_LEXICON_EXIT_LIVE_NAMES, description: DESCRIPTION, changes, notMoved: [], conflicts };
}

export const chudLexiconExitLiveNames: ChantMigration = {
  id: CHUD_LEXICON_EXIT_LIVE_NAMES,
  description: DESCRIPTION,
  plan: planLiveNames,
};
