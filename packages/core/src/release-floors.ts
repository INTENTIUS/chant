/**
 * The version of the next chant release (#4480, #4473).
 *
 * A contract floor added since the last release, the first chant that can
 * write a field, names the release that ships it. That release has no number
 * until the maintainer cuts it, so every such floor is this constant, and the
 * schema and docs text that repeats a floor ("written by chant X and newer",
 * the "Fields added within version 1" rows) is listed in
 * scripts/release-floors.ts, which checks it agrees.
 *
 * To set the number: `npx tsx scripts/release-floors.ts --set <version>`
 * rewrites this constant and every listed text. `just release` refuses to
 * cut a version when any floor names a version that is neither a published
 * release nor the one being cut.
 *
 * After the cut, a floor stays at the value it was released with. Once the
 * release is published, `just release-floors --freeze <version>` writes the
 * version into every floor that names this constant as a literal, and moves
 * this constant to the next patch (#4501). The check fails while a floor
 * still names this constant after its version shipped.
 */
export const NEXT_RELEASE = "0.124.63";
