# design-client

A placeholder for the workspace's design client (#2524 D18): a hud client with the `design-app` role, which edits the artifacts in `../design`.

Nothing is here yet, because no hud client package is published to vendor. When one is, this directory will hold that client, brought in by `chant init --from` or `chant vendor`, and the lineage lock (#2540) will record its upstream: the template id, the commit it came from, its parameters and which of its files are owned, generated or seed. An upgrade of the client then writes only inside this directory and never touches `../design`.

The client has a lineage of its own, separate from this workspace's. The app in `../app` does not embed it, so the app declares no `depends-on` link to it (#2539).
