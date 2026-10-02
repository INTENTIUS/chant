/**
 * `flyRelease`: the `fly-release` capability (../../components/fly-release.ts)
 * as an Op activity (#2782), so an Op's ship phase runs the same site steps a
 * component's deploy does: upload and start, each migration once per
 * environment under a receipt in chant's lifecycle receipt store, verify, and
 * restore on a failure after the Machine changed.
 *
 * An Op has no environment of its own, so the step names the one it ships to
 * (`environment`); the receipts and the recorded Machine configs are that
 * environment's, as they are for the component.
 *
 * Retrying a release that already serves changes nothing: the apply finds the
 * Machine's config unchanged, and every migration's receipt matches.
 */

import type { FlyReleaseInput, FlyReleaseOutput } from "../../components/fly-release";

export interface FlyReleaseArgs extends FlyReleaseInput {
  /** The environment the release ships to: its receipts and recorded configs. (`env` is the Machine's env, as for the capability.) */
  environment: string;
  /** The component the release belongs to, for attribution. Default `app`. */
  component?: string;
}

export type FlyReleaseResult = FlyReleaseOutput;

export async function flyRelease(args: FlyReleaseArgs): Promise<FlyReleaseResult> {
  const { environment, component, ...input } = args;
  if (!environment) throw new Error("flyRelease: name the environment the release ships to (environment)");
  const { flyReleaseCapability } = await import("../../components/fly-release");
  return flyReleaseCapability.run({ env: environment, component: component ?? "app" }, input);
}
