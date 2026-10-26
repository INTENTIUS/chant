/**
 * What the `network` stack publishes. The first three are the ones
 * app.component.ts passes to its `stackOutput` inputs. SubnetCId is exported
 * instead: app imports it by its export name, and no component file names
 * the edge (#4466).
 */
import { stackOutput } from "@intentius/chant";
import { output, Ref } from "@intentius/chant-lexicon-aws";
import { HTTP_PROXY_PORT, mainVpc, subnetA, subnetC } from "./resources";

export const networkVpcId = output(Ref(mainVpc), "VpcId");
export const networkSubnetAId = output(Ref(subnetA), "SubnetAId");
export const networkProxyPort = output(HTTP_PROXY_PORT, "HttpProxyPort");
export const networkSubnetCId = stackOutput(Ref(subnetC), { name: "SubnetCId", exportName: "chant-compose-subnet-c-id" });
