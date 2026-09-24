# Changelog

This file records changes to what chant prints or writes for a plain project, the level-0 changes listed in [#2525](https://github.com/INTENTIUS/chant/issues/2525). The full list, with the release that warned about each one, is on the [level-0 exceptions](docs/src/content/docs/reference/level-0-exceptions.mdx) page.

## 0.80.0

Warning release for four listed level-0 changes. Nothing chant prints on stdout or writes changes in this release; each warning goes to stderr, and the change it warns about can land from the next release.

- [#2514](https://github.com/INTENTIUS/chant/issues/2514) real SHA-256 digests: one warning per project when a release ledger or build manifest holds an old 32-bit digest ([#2568](https://github.com/INTENTIUS/chant/pull/2568)).
- [#2527](https://github.com/INTENTIUS/chant/issues/2527) one discovery walker: each walker warns about the files the converged walker will read differently, and names the `include` or `exclude` glob that keeps today's behaviour ([#2571](https://github.com/INTENTIUS/chant/pull/2571)).
- [#2528](https://github.com/INTENTIUS/chant/issues/2528) audit: a warning when the local walk stops at its 1000-file limit, a new `--max-files <n>` flag, and a warning for each TF023 path that a nested `.gitignore` covers ([#2570](https://github.com/INTENTIUS/chant/pull/2570)).
- [#2574](https://github.com/INTENTIUS/chant/issues/2574) component gate approvals: a warning when a component gate passes on an approval that records no plan ([#2582](https://github.com/INTENTIUS/chant/pull/2582)).
