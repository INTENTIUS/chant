/**
 * The MySQL the MySQL dialect's types are for (#5449).
 *
 * MySQL 8.0 and Aurora MySQL 3 are the supported servers. Aurora MySQL 3 is
 * wire and DDL compatible with MySQL 8.0 (its engine version reads
 * `8.0.mysql_aurora.3.x`), so one catalog serves both: a dialect entry is a
 * MySQL 8.0 entry, and a server that reports itself as Aurora MySQL 3 is read
 * as `8.0`. MariaDB reports a `10.x` or `11.x` version with `MariaDB` in it,
 * and is not a MySQL 8.0: its DDL differs (`JSON` is an alias of `LONGTEXT`,
 * sequences and `INVISIBLE` columns are its own), so it is no entry here.
 *
 * Unlike Postgres and ClickHouse, whose types are read from a pinned server's
 * catalog, MySQL's are listed in the reference manual and in
 * `information_schema` tables that vary little between 8.0 minors. The
 * snapshot `mysql-catalog-8.0.snapshot.json` is the surface of 8.0 as the
 * manual gives it, committed and diffed on a pin move like the others.
 */

export interface MysqlPin {
  /** The major line, `8.0`. */
  major: string;
  /** The minor the snapshot was written against. */
  version: string;
  /** The Aurora MySQL major versions whose engine reads as this major. */
  aurora: readonly string[];
}

/** One pin per supported major line. */
export const MYSQL_PINS: readonly MysqlPin[] = [{ major: "8.0", version: "8.0.40", aurora: ["3"] }];

/** The supported major lines. */
export const MYSQL_MAJORS: readonly string[] = MYSQL_PINS.map((p) => p.major);

export function mysqlPin(major: string): MysqlPin {
  const pin = MYSQL_PINS.find((p) => p.major === major);
  if (!pin) throw new Error(`MySQL ${major} is not a supported major (${MYSQL_MAJORS.join(", ")})`);
  return pin;
}

/** The server a `SELECT VERSION()` answer names, or why it is not one the dialect supports. */
export type MysqlServer =
  | { flavor: "mysql" | "aurora"; major: string; version: string }
  | { flavor: "mariadb"; version: string }
  | { flavor: "unsupported"; version: string };

/**
 * Classify what `VERSION()` returns: `8.0.40`, `8.0.mysql_aurora.3.07.1` (the
 * engine's own spelling; `AURORA_VERSION()` carries the same), `10.11.6-MariaDB`.
 * A server of a major line not in {@link MYSQL_PINS} is `unsupported`, with the
 * version it reported.
 */
export function classifyMysqlVersion(version: string): MysqlServer {
  if (/mariadb/i.test(version)) return { flavor: "mariadb", version };
  const aurora = /^(\d+\.\d+)\.mysql_aurora\.(\d+)/.exec(version);
  if (aurora) {
    const pin = MYSQL_PINS.find((p) => p.major === aurora[1] && p.aurora.includes(aurora[2]!));
    return pin ? { flavor: "aurora", major: pin.major, version } : { flavor: "unsupported", version };
  }
  const plain = /^(\d+\.\d+)\.\d+/.exec(version);
  if (plain && MYSQL_MAJORS.includes(plain[1]!)) return { flavor: "mysql", major: plain[1]!, version };
  return { flavor: "unsupported", version };
}
