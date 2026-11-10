/**
 * `chant dev dead-guards [<product-dir>]` (#4792): each feature-detect in a
 * product whose chant floor the product's pin already meets, so the product
 * deletes it. Exit 1 when there is one, 2 for a usage error.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { deadGuardLine, findDeadGuards } from "../../dead-guards";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

const USAGE = "chant dev dead-guards [<product-dir>] [--chant-version <version>] [--json]";

export async function runDevDeadGuards(ctx: CommandContext): Promise<number> {
  const dir = resolve(ctx.args.extraPositional ?? process.cwd());
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(formatError({ message: `${dir} is not a directory`, hint: USAGE }));
    return 2;
  }
  const r = findDeadGuards({ productDir: dir, ...(ctx.args.chantVersion ? { chant: ctx.args.chantVersion } : {}) });
  if (!ctx.args.chantVersion && r.pins.length === 0) {
    console.error(formatError({ message: `no package.json under ${dir} pins @intentius/chant at a version`, hint: USAGE }));
    return 2;
  }
  if (ctx.args.json) {
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  const against = ctx.args.chantVersion ? `chant ${ctx.args.chantVersion}` : r.pins.map((p) => `${p.file} ${p.pin}`).join(", ");
  if (r.ok) {
    console.error(`dead-guards: ${r.files} files, no feature-detect the pin meets (${r.live.length} still needed; against ${against})`);
    return 0;
  }
  console.error(`dead-guards: ${r.dead.length} feature-detect(s) the pin already meets; delete each check and its fallback (against ${against})`);
  for (const g of r.dead) console.error(`  ${deadGuardLine(g)}`);
  return 1;
}
