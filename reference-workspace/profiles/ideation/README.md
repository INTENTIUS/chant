# Ideation profile

A workspace for decisions and work, with no app to build yet ([#3174](https://github.com/INTENTIUS/chant/issues/3174)). It declares the decision, work and answer record kinds and one member, `app`, a stub of the [app kind](kinds/app) that answers `/health` and shows the workspace's name. The stub keeps the box contract the same as an app workspace's, so a host such as a studio can plant it and people work in its records from the first minute ([arugula-salad/studio#288](https://github.com/arugula-salad/studio/issues/288)). There is no factory and no box block. Growing into a real app is a work item like any other: the stub is replaced, and the factory is declared when there is something to build, as in the app profile.

`chant workspace init --profile ideation` makes a workspace from this directory.
