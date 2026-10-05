import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WIRE_JSON_SCHEMA, WIRE_SCHEMA } from "../server/ai/analyzer.ts";
import { countUnions, fromWire } from "../server/ai/wire.ts";
import { mockAnalysis } from "../server/ai/mock.ts";
import { ChartAnalysisSchema } from "../shared/analysis-schema.ts";

describe("structured-output wire schema", () => {
  it("has no union-type parameters (API limit is 16) and no optional parameters (limit 24)", () => {
    const sent = WIRE_JSON_SCHEMA;
    expect((sent as any).type).toBe("object");
    const setup = (sent as any).properties.setup.properties;
    expect(setup.entry_type.enum).toEqual(["none", "market", "limit", "breakout", "retest", "confirmation"]);
    expect(setup.direction.enum).toEqual(["long", "short", "no_trade"]);
    expect(setup.stop_loss.type).toBe("number");
    expect(setup.stop_loss.description).toMatch(/-1 if not available/);
    expect(JSON.stringify(sent)).not.toMatch(/"(minimum|maximum|maxLength|\$schema)"/);
    expect(countUnions(sent)).toBe(0);
    // every object lists all its properties as required
    const walk = (n: any) => {
      if (!n || typeof n !== "object") return;
      if (n.type === "object") {
        expect(Object.keys(n.properties ?? {}).sort()).toEqual([...(n.required ?? [])].sort());
        expect(n.additionalProperties).toBe(false);
      }
      Object.values(n).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : walk(v)));
    };
    walk(sent);
    // the app schema would have broken the limit
    expect(countUnions(z.toJSONSchema(ChartAnalysisSchema))).toBeGreaterThan(16);
  });

  it("round-trips: sentinels become null and valid values survive", () => {
    const app = mockAnalysis({ images: [{ data: new Uint8Array(), mime: "image/png", label: null, width: 1, height: 1 }], symbolHint: null, notes: "[mock:no-trade]" });
    // app -> wire (nulls to sentinels), as the model would answer
    const toWireValue = (v: any): any =>
      v === null ? null : Array.isArray(v) ? v.map(toWireValue) : typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toWireValue(x)])) : v;
    const wire = JSON.parse(
      JSON.stringify(toWireValue(app), (_k, v) => v),
    );
    // replace nulls with the sentinel each field type would use
    const fill = (schema: any, v: any): any => {
      if (schema instanceof z.ZodNullable) {
        const inner = schema.unwrap();
        if (v === null) return inner instanceof z.ZodNumber ? -1 : inner instanceof z.ZodString ? "" : "none";
        return fill(inner, v);
      }
      if (schema instanceof z.ZodObject) return Object.fromEntries(Object.entries(schema.shape).map(([k, s]) => [k, fill(s, v[k])]));
      if (schema instanceof z.ZodArray) return v.map((x: any) => fill(schema.element, x));
      return v;
    };
    const sentinelised = fill(ChartAnalysisSchema, wire);
    expect(WIRE_SCHEMA.safeParse(sentinelised).success).toBe(true);
    expect(sentinelised.setup.entry_type).toBe("none");
    expect(sentinelised.setup.stop_loss).toBe(-1);
    expect(sentinelised.symbol).toBe("MOCK");
    const back = fromWire(ChartAnalysisSchema, sentinelised);
    expect(ChartAnalysisSchema.parse(back)).toEqual(app);
  });
});
