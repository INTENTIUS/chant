/**
 * `flyRollback`: the `fly-rollback` capability (../../components/fly-release.ts)
 * as an Op activity (#2800), so a rollback Op puts an earlier release back on
 * the Machine the way the release Op's `flyRelease` put it there.
 *
 * It restores the Machine config `fly-release` recorded for the release it
 * goes back to (files included), in the environment `environment` names, and
 * checks that the Machine is started with that release. Given `source`, the
 * archive is read only once it hashes to its digest, before any flaps call,
 * and the recorded config must carry exactly that tree, or nothing changes.
 * A release with no recorded config is refused by name.
 *
 * Running it again once the Machine serves the release changes nothing.
 * Migrations are not undone: the data stays where the later release left it.
 */

import type { FlyRollbackInput, FlyRollbackOutput } from "../../components/fly-release";

export interface FlyRollbackArgs extends FlyRollbackInput {
  /** The environment whose recorded Machine configs are read. */
  environment: string;
  /** The component the release belongs to, for attribution. Default `app`. */
  component?: string;
}

export type FlyRollbackResult = FlyRollbackOutput;

export async function flyRollback(args: FlyRollbackArgs): Promise<FlyRollbackResult> {
  const { environment, component, ...input } = args;
  if (!environment) throw new Error("flyRollback: name the environment whose release it restores (environment)");
  const { flyRollbackCapability } = await import("../../components/fly-release");
  return flyRollbackCapability.run({ env: environment, component: component ?? "app" }, input);
}
