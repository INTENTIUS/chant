/**
 * One endpoint's way in through Route 53: a latency record for a shared name,
 * guarded by a health check on that endpoint (#4264). A record whose check
 * fails stops answering, and the other entries for the same name take its
 * traffic. The endpoint can live in any cloud.
 *
 * HostnameEntry is for an endpoint with a hostname (a load balancer's, a
 * Container App's): the record is a CNAME to it and the check probes it by
 * name. AddressEntry is for an endpoint that is an IP address: it gets a name
 * of its own, an A record, the latency record is a CNAME to that name, and the
 * check probes the address. Latency records sharing a name must share a type,
 * which is why the address gets its own A record instead of the latency
 * record being one.
 */
import { Composite, mergeDefaults, type Value } from "@intentius/chant";
import { HealthCheck, RecordSet } from "../generated";

export interface LatencyEntryCheck {
  /** Defaults to "HTTP". */
  protocol?: "HTTP" | "HTTPS";
  /** The path the check requests. Defaults to "/". */
  path?: string;
  /** When set, the check passes only if the response body contains this string (an `_STR_MATCH` check). */
  searchString?: string;
}

export interface HostnameEntryProps {
  /** The hosted zone's id (`zone.Id`). */
  zoneId: Value<string>;
  /** The name every entry answers for. */
  name: Value<string>;
  /** The record's set identifier, unique among the entries for `name`. */
  id: string;
  /** The AWS region whose latency this record is chosen for. */
  region: string;
  /** The endpoint: a hostname here, an IP address for AddressEntry. */
  endpoint: Value<string>;
  /** The port the check probes. Defaults to the protocol's port (80 or 443). */
  port?: number;
  /** The records' TTL in seconds. Defaults to 60. */
  ttl?: number;
  check?: LatencyEntryCheck;
  defaults?: {
    check?: Partial<ConstructorParameters<typeof HealthCheck>[0]>;
    record?: Partial<ConstructorParameters<typeof RecordSet>[0]>;
  };
}

export interface AddressEntryProps extends HostnameEntryProps {
  /** The name the address is published under (an A record), which the latency record points at. */
  origin: Value<string>;
  /** The port the check probes. */
  port: number;
  defaults?: HostnameEntryProps["defaults"] & {
    origin?: Partial<ConstructorParameters<typeof RecordSet>[0]>;
  };
}

function checkType(check: LatencyEntryCheck | undefined): string {
  const protocol = check?.protocol ?? "HTTP";
  return check?.searchString !== undefined ? `${protocol}_STR_MATCH` : protocol;
}

/** A Route 53 latency CNAME to a hostname endpoint, guarded by a health check probing that hostname. */
export const HostnameEntry = Composite((props: HostnameEntryProps) => {
  const check = new HealthCheck(mergeDefaults({
    HealthCheckConfig: {
      Type: checkType(props.check),
      FullyQualifiedDomainName: props.endpoint,
      ResourcePath: props.check?.path ?? "/",
      RequestInterval: 10,
      FailureThreshold: 1,
      ...(props.port !== undefined ? { Port: props.port } : {}),
      ...(props.check?.searchString !== undefined ? { SearchString: props.check.searchString } : {}),
    },
  }, props.defaults?.check));
  const record = new RecordSet(mergeDefaults({
    HostedZoneId: props.zoneId,
    Name: props.name,
    Type: "CNAME",
    TTL: String(props.ttl ?? 60),
    SetIdentifier: props.id,
    Region: props.region,
    ResourceRecords: [props.endpoint],
    HealthCheckId: check.HealthCheckId,
  }, props.defaults?.record));
  return { check, record };
}, "HostnameEntry");

/** A Route 53 latency CNAME to an A record naming an IP endpoint, guarded by a health check probing that address. */
export const AddressEntry = Composite((props: AddressEntryProps) => {
  const check = new HealthCheck(mergeDefaults({
    HealthCheckConfig: {
      Type: checkType(props.check),
      IPAddress: props.endpoint,
      Port: props.port,
      ResourcePath: props.check?.path ?? "/",
      RequestInterval: 10,
      FailureThreshold: 1,
      ...(props.check?.searchString !== undefined ? { SearchString: props.check.searchString } : {}),
    },
  }, props.defaults?.check));
  const origin = new RecordSet(mergeDefaults({
    HostedZoneId: props.zoneId,
    Name: props.origin,
    Type: "A",
    TTL: String(props.ttl ?? 60),
    ResourceRecords: [props.endpoint],
  }, props.defaults?.origin));
  const record = new RecordSet(mergeDefaults({
    HostedZoneId: props.zoneId,
    Name: props.name,
    Type: "CNAME",
    TTL: String(props.ttl ?? 60),
    SetIdentifier: props.id,
    Region: props.region,
    ResourceRecords: [props.origin],
    HealthCheckId: check.HealthCheckId,
  }, props.defaults?.record));
  return { check, origin, record };
}, "AddressEntry");
