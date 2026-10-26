/**
 * What `app` publishes: the port it listens on, which edge routes to, and the
 * network interface it put in network's subnet c, exported for edge to
 * import (#4466).
 */
import { stackOutput } from "@intentius/chant";
import { output, Ref } from "@intentius/chant-lexicon-aws";
import { appHttpProxyPort } from "./params";
import { importsInterface } from "./resources";

export const appListenerPort = output(Ref(appHttpProxyPort), "ListenerPort");
export const appImportsInterfaceId = stackOutput(Ref(importsInterface), { name: "ImportsInterfaceId", exportName: "chant-compose-imports-interface" });
