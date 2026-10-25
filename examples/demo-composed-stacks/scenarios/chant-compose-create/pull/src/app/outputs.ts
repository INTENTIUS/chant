/** What `app` publishes: the port it listens on, which edge routes to, and the subnet its worker is in. */
import { output, Ref } from "@intentius/chant-lexicon-aws";
import { appHttpProxyPort, appSubnetBId } from "./params";

export const appListenerPort = output(Ref(appHttpProxyPort), "ListenerPort");
export const appWorkerSubnetId = output(Ref(appSubnetBId), "WorkerSubnetId");
