import { output } from "@intentius/chant-lexicon-aws";
import { shared } from "./shared";

export const albDnsName = output(shared.alb.DNSName, "AlbDnsName");
