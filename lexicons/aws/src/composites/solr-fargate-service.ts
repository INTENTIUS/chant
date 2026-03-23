import { Composite } from "@intentius/chant";
import { FargateService, FargateServiceProps } from "./fargate-service";

export interface SolrFargateServiceProps extends FargateServiceProps {
  /**
   * JVM heap size passed as SOLR_HEAP. Defaults to 45% of task memory.
   * Examples: "1843m", "4g". Must not exceed 50% of task memory.
   */
  solrHeap?: string;
  /**
   * GC tuning string passed as GC_TUNE.
   * Default: "-XX:+UseG1GC -XX:MaxGCPauseMillis=200"
   */
  gcOpts?: string;
}

export const SolrFargateService = Composite<SolrFargateServiceProps>((props) => {
  const memoryMb = parseInt(props.memory ?? "4096");
  const solrHeap = props.solrHeap ?? `${Math.floor(memoryMb * 0.45)}m`;
  const gcOpts = props.gcOpts ?? "-XX:+UseG1GC -XX:MaxGCPauseMillis=200";

  // Solr env defaults — user-supplied environment entries override these
  const solrEnv: Record<string, string> = {
    SOLR_HEAP: solrHeap,
    GC_TUNE: gcOpts,
    SOLR_OPTS: "-XX:-UseLargePages",
    ...props.environment,
  };

  // Solr-specific ulimit default — user-supplied ulimits override
  const solrUlimits = props.ulimits ?? [
    { name: "nofile", softLimit: 65535, hardLimit: 65535 },
  ];

  return FargateService({
    containerPort: 8983,
    healthCheckPath: "/solr/admin/info/health",
    ...props,
    environment: solrEnv,
    ulimits: solrUlimits,
  });
}, "SolrFargateService");
