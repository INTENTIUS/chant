# Infra profile

A workspace for an estate, with no app member and no box services ([#3174](https://github.com/INTENTIUS/chant/issues/3174)). Its one member, `network`, is a chant project on the terraform lexicon. The box block on it declares only the factory, which builds `network` and checks a build with a lint and a build of it, so infra changes run the same loop as app changes. The factory runs on a fountain steward, not a planted box, so the workspace is not plantable, and `chant workspace check` passes all the same. Delete the `box` block for an infra workspace that doesn't build with agents.

`chant workspace init --profile infra` makes a workspace from this directory.
