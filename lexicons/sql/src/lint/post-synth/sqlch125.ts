import { CODECS, CLICKHOUSE_VERSION } from "../../generated/clickhouse";
import { checkOf, isTable, splitTop } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

type Param = { name: string; kind: string; optional?: boolean; range?: readonly [number, number]; values?: readonly string[] };

const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * SQLCH125: a codec's parameters do not fit it: more than the codec takes
 * (`LZ4(1)`), a number outside its range (`ZSTD(99)`, `LZ4HC(13)`), or a
 * value outside its set (`Delta(3)`; the byte width is 1, 2, 4 or 8).
 *
 * The parameters are the `CODEC_OVERLAY`'s; a codec marked `"unknown"` there
 * (the experimental ones with undocumented parameters) is not checked. An
 * unknown codec name is SQLCH114's.
 */
export const sqlch125 = checkOf({ id: "SQLCH125", description: "A codec parameter is outside what the codec takes" }, (ctx, report) => {
  const codecs = CODECS as Record<string, { parameters: readonly Param[] | "unknown" } | undefined>;
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    for (const c of t.columns) {
      if (!c.codec) continue;
      for (const part of splitTop(c.codec)) {
        const m = /^([A-Za-z_]\w*)\s*(?:\(([\s\S]*)\))?$/.exec(part.trim());
        if (!m) continue;
        const name = m[1]!;
        const spec = codecs[name] ?? Object.entries(codecs).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
        if (!spec || spec.parameters === "unknown" || m[2] === undefined) continue;
        const args = splitTop(m[2]);
        const where = `${t.export} (${t.name}): column ${c.name} CODEC(${c.codec})`;
        const expected = spec.parameters;
        if (args.length > expected.length) {
          const takes = expected.length === 0 ? "takes no parameters" : `takes at most ${expected.length} (${expected.map((p) => p.name).join(", ")})`;
          report({ severity: "error", message: `${where}: ${name} ${takes}, and is given ${args.length}`, entity: t.export });
          continue;
        }
        args.forEach((arg, i) => {
          const p = expected[i]!;
          const text = arg.trim();
          if (p.values && !p.values.some((v) => v.toLowerCase() === text.toLowerCase())) {
            report({ severity: "error", message: `${where}: ${name} ${p.name} ${text} is not one of ${p.values.join(", ")}`, entity: t.export });
          } else if (p.range && NUMBER.test(text)) {
            const n = Number(text);
            if (n < p.range[0] || n > p.range[1]) {
              report({
                severity: "error",
                message: `${where}: ${name} ${p.name} ${text} is outside ${p.range[0]} to ${p.range[1]}, the range ClickHouse ${CLICKHOUSE_VERSION} takes`,
                entity: t.export,
              });
            }
          }
        });
      }
    }
  }
});
