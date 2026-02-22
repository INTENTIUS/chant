import { output } from "@intentius/chant-lexicon-aws";
import { web } from "./service";

export const albDnsName = output(web.alb.DNSName, "AlbDnsName");
