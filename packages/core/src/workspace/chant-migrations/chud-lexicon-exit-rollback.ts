/**
 * `chud-lexicon-exit-rollback` (#2800): give a repo `chud-lexicon-exit`
 * migrated the rollback Op chud had, on chant's own steps.
 *
 * `chud-lexicon-exit` shipped in 0.92.0 with a release Op that ships the app
 * member to Fly as a source tree (#2782), and it deleted chud's rollback Op
 * because nothing in chant could take that site back yet. This migration
 * writes `ops/rollback.op.ts` beside the release Op, and a `rollback` script.
 * A repo `chud-lexicon-exit` migrates from now on gets both, since this
 * migration is planned after it in the same upgrade.
 *
 * The rollback is an Op rather than `chant components rollback` because the
 * release is one: the release Op archives, plans, gates, ships and records,
 * and the app component only runs the supply chain. Rolling back through the
 * component would put publish and rollback in two places, which the boundary
 * between Ops and components says not to do (components/backends-reference).
 *
 * The plan is empty unless the member's release Op is the one
 * `chud-lexicon-exit` wrote, and once the rollback Op is there. A file at
 * `ops/rollback.op.ts` that is not this one is a conflict.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { ChantMigration, ChantMigrationContext, ChantMigrationPlan, PlanConflict, PlannedChange } from "../chant-migrations";
import { CHUD_LEXICON_EXIT } from "./chud-lexicon-exit";

export const CHUD_LEXICON_EXIT_ROLLBACK = "chud-lexicon-exit-rollback";

const DESCRIPTION = "add the rollback Op to a repo chud-lexicon-exit migrated: the previous source release back on the Fly site (#2800)";

/** The release Op `chud-lexicon-exit` writes, recognised by what it holds. */
function isExitReleaseOp(text: string): boolean {
  return text.includes(`its migration ${CHUD_LEXICON_EXIT}`) && text.includes("flyRelease(") && text.includes("releasePlan(");
}

export function rollbackOp(pointsRel: string): string {
  return `/**
 * Rollback: put the release the Fly site served before the latest one back
 * on it, once the rollback plan is approved, and record it.
 *
 * \`chant workspace upgrade\` wrote this (its migration ${CHUD_LEXICON_EXIT_ROLLBACK})
 * in place of chud's rollback Op, beside the release Op (ops/release.op.ts):
 *
 * - Plan reads the \`fly\` release ledger. The release it goes back to is the
 *   one the site served before the latest release the release Op shipped
 *   (\`to: "sha256:..."\` on the plan step picks another). Its plan is read
 *   back from chant/lifecycle, its commit's app member is archived again, and
 *   the run stops unless the archive hashes to the digest that plan
 *   recorded. The rollback plan names both releases and the archive, and is
 *   named by its own sha256. Build writes the Fly app's requests.
 * - The \`rollback\` gate approves that plan's digest: \`chant approve rollback
 *   rollback --plan <digest>\`. It takes the ship gate's approver count and
 *   Cedar policy (decisions/ship-skip.cedar.ts, \`log-only\`): a rollback has
 *   no ship-skip answer, so only people pass it.
 * - Roll back reads the archive again, refused unless it still hashes to the
 *   planned digest, before any call to Fly. The Machine config the release
 *   Op recorded for that release must carry exactly that tree under
 *   /srv/app, or nothing changes. Then that config goes back on the Machine,
 *   files and start command included, and the Machine must be started with
 *   that release (and healthy at \`chud.sites.fly.url\` when set). Migrations
 *   are not undone: the data stays where the later release left it.
 * - Record appends the restored release to the \`fly\` release ledger, with
 *   \`restores\` naming it, the actor who ran the rollback and the approver.
 *
 * Running it again changes nothing: the same ledger plans the same rollback,
 * so its approval holds, the Machine already serves the release, and the
 * ledger is written once. A release shipped after the rollback is the latest
 * one again, so the next rollback goes back from it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Op, phase, gate, build, releaseRollbackPlan, releaseRollbackRecord } from "@intentius/chant/op";
import { parsePoints, quorumOf } from "@intentius/chant/workspace/points";
import { flyRollback } from "@intentius/chant-lexicon-fly";
import project from "../chant.config.ts";
import { shipSkipPolicy } from "../decisions/ship-skip.cedar.ts";

/** The environment the release Op ships to. */
const ENV = "fly";
/** Where the release Op put the files on the Machine. */
const INTO = "/srv/app";
const params = project.buildParams;
/** The Fly site's public URL, when chant.config.ts gives one: the restored release is verified at its health endpoint too. */
const siteUrl = (project as { chud?: { sites?: { fly?: { url?: string } } } }).chud?.sites?.fly?.url;

const pointsFile = fileURLToPath(new URL(${JSON.stringify(pointsRel)}, import.meta.url));
const shipSkipPoint = parsePoints(readFileSync(pointsFile, "utf-8"), pointsFile)["ship-skip"];

const plan = releaseRollbackPlan({ id: "plan", component: "app", env: ENV });

export default Op({
  name: "rollback",
  overview: \`Put the previous release of \${params.name.default} back on Fly once the rollback plan is approved.\`,
  phases: [
    phase("Plan", [plan, build(".", { script: "build:fly" })]),
    phase("Gate", [
      gate("rollback", {
        plan: plan.out.digest,
        description: \`Roll \${params.name.default} on \${ENV} back to its previous release\`,
        approval: { quorum: quorumOf(shipSkipPoint), policy: shipSkipPolicy, mode: "log-only" },
      }),
    ]),
    phase("Roll back", [
      flyRollback({
        environment: ENV,
        component: "app",
        plan: "dist/fly.json",
        to: plan.out.to,
        source: { archive: plan.out.archive, digest: plan.out.archiveDigest, dir: plan.out.dir, into: INTO },
        verify: { url: siteUrl, healthPath: params.appHealth.default },
      }),
    ]),
    phase("Record", [releaseRollbackRecord({ plan: plan.out.file, digest: plan.out.digest, approval: { op: "rollback", gate: "rollback" } })]),
  ],
});
`;
}

/** The release Op's sentence about the rollback, as chud-lexicon-exit wrote it, and what it says once the rollback Op is there. */
const RELEASE_SAID = /\), and rolling the site back to the previous\n \* release \(INTENTIUS\/chant#2800\)\. /;
const RELEASE_SAYS = "). ops/rollback.op.ts rolls the site back to the\n * previous release. ";

interface Declaration {
  members?: Array<{ name?: string; dir?: string; kind?: string }>;
}

function readText(dir: string, path: string): string | undefined {
  const abs = join(dir, path);
  return existsSync(abs) ? readFileSync(abs, "utf-8") : undefined;
}

function planRollback(ctx: ChantMigrationContext): ChantMigrationPlan | null {
  const { dir } = ctx;
  let decl: Declaration | null = null;
  try {
    decl = JSON.parse(readText(dir, "chant.workspace.json") ?? "null") as Declaration | null;
  } catch {
    decl = null;
  }
  const candidates = (decl?.members ?? []).filter((m) => m.kind === "chant" && m.dir).map((m) => posix.normalize(m.dir!));
  if (!candidates.includes("delivery")) candidates.push("delivery");
  const members = candidates.filter((d) => {
    const release = readText(dir, posix.join(d, "ops/release.op.ts"));
    return release !== undefined && isExitReleaseOp(release);
  });
  if (members.length === 0) return null;

  const changes: PlannedChange[] = [];
  const conflicts: PlanConflict[] = [];
  for (const d of members) {
    const at = (p: string) => posix.join(d, p);
    const opPath = at("ops/rollback.op.ts");
    const text = rollbackOp(posix.relative(at("ops"), "decisions/points.json"));
    const current = readText(dir, opPath);
    if (current === undefined) {
      changes.push({ path: opPath, action: "write", why: "chant's rollback Op: Plan from the release ledger with the archive checked again, the rollback gate, Roll back on Fly, and Record", data: Buffer.from(text) });
    } else if (current !== text && !current.includes(`its migration ${CHUD_LEXICON_EXIT_ROLLBACK}`)) {
      conflicts.push({ path: opPath, reason: "exists and is not the rollback Op this migration writes. Move it aside or delete it, then run the upgrade again" });
      continue;
    }

    // The release Op's comment named the rollback as not chant's yet.
    const releasePath = at("ops/release.op.ts");
    const release = readText(dir, releasePath)!;
    const said = RELEASE_SAID.exec(release);
    if (said) {
      changes.push({ path: releasePath, action: "write", why: "its comment names ops/rollback.op.ts", data: Buffer.from(release.replace(RELEASE_SAID, RELEASE_SAYS)) });
    }

    const pkgPath = at("package.json");
    const pkgText = readText(dir, pkgPath);
    if (pkgText !== undefined) {
      try {
        const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
        if (pkg.scripts?.release === "chant run release" && pkg.scripts.rollback === undefined) {
          const scripts: Record<string, string> = {};
          for (const [k, v] of Object.entries(pkg.scripts)) {
            scripts[k] = v;
            if (k === "release") scripts.rollback = "chant run rollback";
          }
          const next = JSON.stringify({ ...pkg, scripts }, null, 2) + "\n";
          changes.push({ path: pkgPath, action: "write", why: "adds `rollback`: chant run rollback", data: Buffer.from(next) });
        }
      } catch {
        conflicts.push({ path: pkgPath, reason: "is not JSON" });
      }
    }
  }
  return { id: CHUD_LEXICON_EXIT_ROLLBACK, description: DESCRIPTION, changes, notMoved: [], conflicts };
}

export const chudLexiconExitRollback: ChantMigration = {
  id: CHUD_LEXICON_EXIT_ROLLBACK,
  description: DESCRIPTION,
  plan: planRollback,
};
