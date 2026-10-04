# App profile

A workspace that builds an app with agents ([#3174](https://github.com/INTENTIUS/chant/issues/3174)). Its `app` member is of the [app kind](kinds/app), and its box block runs the app as a service and declares the factory: the factory builds `app`, and a build's verdict is the app's tests. The decision, work and answer record kinds hold what people decide and what the factory builds, and `writeScope` keeps agents to new decisions and work items and away from the declaration and the kinds. Add `builders` and builder tiers once a member declares the builder agents.

`chant workspace init --profile app` makes a workspace from this directory.
