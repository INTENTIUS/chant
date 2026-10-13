#!/bin/sh
# TypeScript 7's tsc (chant #3088). Every typecheck and every package and
# lexicon .d.ts build runs through here.
#
# TypeScript 7 is installed at the root as the alias `typescript-native`. The
# `typescript` package stays on 5.9, because core, the lexicon lint rules and
# eslint import its JS compiler API, which TypeScript 7 does not have. Both
# packages ship a `tsc` bin, so this calls TypeScript 7 by path instead of
# relying on node_modules/.bin/tsc.
#
# A --noEmit check with declarations on is slower on TypeScript 7 than on 5.9,
# so the noEmit callers pass --declaration false --declarationMap false.
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/node_modules/typescript-native/bin/tsc" "$@"
