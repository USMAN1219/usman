/**
 * Wire format for structured outputs.
 *
 * The Claude API's strict structured outputs allow at most 16 parameters with
 * union types (anyOf / ["x","null"]) per request, and every `.nullable()`
 * field counts. The app schema uses null for "unknown" in ~45 places, so we
 * derive a union-free wire schema from it:
 *   nullable number -> number, -1 means "not available"
 *   nullable string -> string, "" means "not available"
 *   nullable enum   -> enum + "none"
 * and convert the model's answer back with `fromWire`. Prices, positions and
 * image indexes are never legitimately negative, so -1 is unambiguous.
 */
import { z } from "zod";

const NUM_SENTINEL = -1;

function describe<T extends z.ZodType>(s: T, base: string | undefined, extra: string): T {
  return s.describe([base, extra].filter(Boolean).join(" ")) as T;
}

/** Builds the union-free schema sent to the model. */
export function toWireSchema(schema: z.ZodType): z.ZodType {
  const desc = schema.description;
  if (schema instanceof z.ZodNullable) {
    const inner = schema.unwrap() as z.ZodType;
    const innerDesc = inner.description ?? desc;
    if (inner instanceof z.ZodNumber) return describe(inner, innerDesc, `Use ${NUM_SENTINEL} if not available.`);
    if (inner instanceof z.ZodString) return describe(inner, innerDesc, `Use an empty string if not available.`);
    if (inner instanceof z.ZodEnum) {
      const opts: [string, ...string[]] = ["none", ...(inner.options as string[])];
      return describe(z.enum(opts), innerDesc, `Use "none" if not applicable.`);
    }
    throw new Error(`Unsupported nullable type in wire schema: ${inner.constructor.name}`);
  }
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {};
    for (const [k, v] of Object.entries(schema.shape as Record<string, z.ZodType>)) shape[k] = toWireSchema(v);
    const obj = z.object(shape);
    return desc ? obj.describe(desc) : obj;
  }
  if (schema instanceof z.ZodArray) {
    const arr = z.array(toWireSchema(schema.element as z.ZodType));
    return desc ? arr.describe(desc) : arr;
  }
  return schema;
}

/** Converts a wire-format value back to the app shape (sentinels -> null), guided by the app schema. */
export function fromWire(schema: z.ZodType, value: unknown): unknown {
  if (schema instanceof z.ZodNullable) {
    const inner = schema.unwrap() as z.ZodType;
    if (value === null || value === undefined) return null;
    if (inner instanceof z.ZodNumber) return typeof value === "number" && value < 0 ? null : value;
    if (inner instanceof z.ZodString) return typeof value === "string" && value.trim() === "" ? null : value;
    if (inner instanceof z.ZodEnum) return value === "none" ? null : value;
    return fromWire(inner, value);
  }
  if (schema instanceof z.ZodObject && value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.shape as Record<string, z.ZodType>)) out[k] = fromWire(v, (value as Record<string, unknown>)[k]);
    return out;
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) return value.map((v) => fromWire(schema.element as z.ZodType, v));
  return value;
}

/** Counts parameters that would compile to union types (for tests / sanity checks). */
export function countUnions(jsonSchema: unknown): number {
  let n = 0;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.anyOf) || Array.isArray(o.oneOf) || Array.isArray(o.type)) n++;
    Object.values(o).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : walk(v)));
  };
  walk(jsonSchema);
  return n;
}
