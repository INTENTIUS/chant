/**
 * The CC lane's canonical example, release half (chant#1198 / behold#100).
 *
 * One component owning the whole stack, and `liveNames` is the part that
 * matters here: it lists the ten declared resources this component owns, so
 * `chant components status local --live --json` reports a `resources` rollup
 * (chant#1300) of ten rather than the degenerate rollup-of-one an identity join
 * produces. That rollup is what behold#100 has to paint from.
 *
 * One stack rather than a network/app split: chant's directory partitioning
 * does not carry a cross-stack reference through a scoped build here (a scoped
 * `chant build src/cc-app` fails to resolve the imported subnet's AttrRef), and
 * proving that out is #1208's problem, not this slot's. The `src/cc-network/`
 * and `src/cc-app/` directories still give behold's logical projection two
 * component boxes to nest, because it groups by declaring directory rather than
 * by component declaration.
 */
import { phase, type Component } from "@intentius/chant/components/component";
import { cfnDeploy } from "@intentius/chant-lexicon-aws/components";

export const canonical: Component = {
  name: "cc-canonical",
  archetype: "infra",
  dependsOn: [],
  liveNames: [
    "vpc",
    "igw",
    "igwAttachment",
    "publicSubnet",
    "privateSubnet",
    "publicRouteTable",
    "publicRoute",
    "publicRta",
    "appSecurityGroup",
    "appInstance",
    "cluster",
  ],
  deploy: [phase("Apply", [cfnDeploy({ stack: "cc-canonical", template: "template.json" })])],
};
