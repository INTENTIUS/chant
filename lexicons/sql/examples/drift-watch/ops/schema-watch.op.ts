import { WatchOp } from "@intentius/chant/op";

// Every hour at :17, read the prod server and report drift: an owned object
// changed or gone. An object the project did not create is not reported.
const { op } = WatchOp({ name: "schema-watch", env: "prod", schedule: "17 * * * *" });

export default op;
