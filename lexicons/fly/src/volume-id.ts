/**
 * A Fly volume's id, as the Machines API gives it (`vol_r68lmz2doox9myd4`).
 * A Machine's `config.mounts[].volume` takes this id; chant also lets it name
 * a volume, and `flyApply` looks the name up (#4717). Kept apart from the
 * applier so the FLY011 lint check can use it without loading the applier.
 */

/** True when `value` is a volume id (`vol_...`), not a volume's name. Pure. */
export function isVolumeId(value: string): boolean {
  return /^vol_[A-Za-z0-9]+$/.test(value);
}
