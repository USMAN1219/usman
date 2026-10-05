/**
 * Structured schema the vision model must fill in for every chart analysis.
 *
 * This is the single contract between the AI layer, the backend guardrails and
 * the UI. Every field is required and uses `null` (not omission) for "unknown",
 * which keeps the schema compatible with strict structured outputs and forces
 * the model to make an explicit statement about missing information instead of
 * silently skipping it.
 *
 * Prices are plain numbers as read from the chart's price axis. Positions on
 * the screenshot are fractions of the image size (0 = left/top, 1 = right/bottom)
 * so they survive resizing.
 */
import { z } from "zod";

export const GRADES = ["A+", "A", "B", "C"] as const;
export const ZONE_GRADES = ["A+", "A", "B", "weak"] as const;

const nullableNumber = z.number().nullable();
const fraction = z
  .number()
  .nullable()
  .describe("Position as a fraction of image width/height (0..1), or null if not confidently locatable.");

const imageIndex = z
  .number()
  .int()
  .nullable()
  .describe("0-based index of the uploaded image this item was read from, or null if it spans several.");

export const ChartReadingSchema = z.object({
  image_index: z.number().int(),
  detected_symbol: z.string().nullable(),
  detected_timeframe: z.string().nullable().describe("Normalised: 1m, 5m, 15m, 30m, 1h, 4h, 1D, or another label."),
  timeframe_source: z.enum(["user_label", "visible_on_chart", "inferred", "unknown"]),
  price_scale_readable: z.boolean(),
  current_price: nullableNumber,
  usable: z.boolean().describe("False if this image cannot support price-level analysis."),
  issues: z.array(z.string()),
});

export const PriceLevelSchema = z.object({
  kind: z.enum(["support", "resistance"]),
  price: z.number(),
  price_high: nullableNumber.describe("Upper bound if the level is really a narrow area; otherwise null."),
  timeframe: z.string().nullable(),
  importance: z.enum(["major", "minor"]),
  reason: z.string(),
  image_index: imageIndex,
  x_start: fraction,
});

export const LiquidityPoolSchema = z.object({
  price: z.number(),
  type: z.enum([
    "equal_highs",
    "equal_lows",
    "previous_high",
    "previous_low",
    "swing_high",
    "swing_low",
    "range_high",
    "range_low",
    "other",
  ]),
  scope: z.enum(["internal", "external"]),
  status: z.enum(["untaken", "partially_taken", "swept", "fully_taken"]),
  description: z.string(),
  timeframe: z.string().nullable(),
  image_index: imageIndex,
});

export const SweepSchema = z.object({
  side: z.enum(["buy_side", "sell_side"]),
  price: z.number(),
  timeframe: z.string().nullable(),
  rejection_strength: z.enum(["strong", "moderate", "weak"]),
  description: z.string(),
  image_index: imageIndex,
  x: fraction,
});

export const StructureEventSchema = z.object({
  type: z.enum(["BOS", "CHOCH"]),
  direction: z.enum(["bullish", "bearish"]),
  level_price: nullableNumber,
  timeframe: z.string().nullable(),
  strength: z.enum(["strong", "moderate", "weak"]),
  displacement: z.boolean(),
  after_liquidity_event: z.boolean(),
  description: z.string(),
  image_index: imageIndex,
  x: fraction,
});

export const ZoneSchema = z.object({
  kind: z.enum(["supply", "demand"]),
  price_low: z.number(),
  price_high: z.number(),
  timeframe: z.string().nullable(),
  grade: z.enum(ZONE_GRADES),
  fresh: z.boolean().describe("True if price has not yet returned to the zone since it formed."),
  reason: z.string(),
  image_index: imageIndex,
  x_start: fraction,
});

export const FvgSchema = z.object({
  direction: z.enum(["bullish", "bearish"]),
  price_low: z.number(),
  price_high: z.number(),
  timeframe: z.string().nullable(),
  status: z.enum(["fresh", "partially_filled", "filled", "respected", "invalidated"]),
  context: z.string().describe("Displacement / BOS / CHOCH / sweep it is associated with."),
  image_index: imageIndex,
  x_start: fraction,
});

export const OrderBlockSchema = z.object({
  direction: z.enum(["bullish", "bearish"]),
  price_low: z.number(),
  price_high: z.number(),
  timeframe: z.string().nullable(),
  quality: z.enum(ZONE_GRADES),
  status: z.enum(["unmitigated", "mitigated", "respected", "invalidated"]),
  reason: z.string(),
  image_index: imageIndex,
  x_start: fraction,
});

export const ConfluenceSchema = z.object({
  factor: z.string(),
  present: z.boolean(),
  note: z.string(),
});

export const SetupSchema = z.object({
  direction: z.enum(["long", "short", "no_trade"]),
  entry_type: z.enum(["market", "limit", "breakout", "retest", "confirmation"]).nullable(),
  entry_low: nullableNumber,
  entry_high: nullableNumber.describe("Same as entry_low for a single-price entry."),
  stop_loss: nullableNumber,
  tp1: nullableNumber,
  tp2: nullableNumber,
  tp3: nullableNumber.describe("Only when technically justified; otherwise null."),
  stop_reason: z.string().nullable(),
  target_reasons: z.array(z.string()),
  grade: z.enum([...GRADES, "no_trade"]),
  confidence: z.enum(["high", "medium", "low"]).describe("Analytical confidence in the reading of the evidence, NOT probability of profit."),
  trade_style: z.enum(["scalping", "intraday", "short_swing", "swing"]).nullable(),
  requires_confirmation: z.boolean(),
  confluence: z.array(ConfluenceSchema),
  why: z.string(),
  invalidation: z.string(),
  wait_for: z.string().describe("Exact confirmation still required before entry, or what to wait for when there is no trade."),
  no_trade_reasons: z.array(z.string()),
});

export const CalibrationSchema = z.object({
  image_index: z.number().int(),
  y1: z.number().describe("Vertical position (0..1 of image height) of the centre of a clearly readable price-axis label."),
  price1: z.number(),
  y2: z.number().describe("Vertical position of a second readable label, far from the first."),
  price2: z.number(),
  plot_left: z.number().describe("Left edge of the candle plotting area (0..1 of width)."),
  plot_right: z.number().describe("Right edge of the candle plotting area, just left of the price axis."),
  scale: z.enum(["linear", "logarithmic", "unknown"]),
  confidence: z.enum(["high", "medium", "low"]),
});

export const ChartAnalysisSchema = z.object({
  charts: z.array(ChartReadingSchema),
  same_instrument: z.boolean(),
  readability_issues: z.array(z.string()),
  symbol: z.string().nullable(),
  current_price: nullableNumber,
  timeframes: z.array(z.string()),
  market_condition: z.enum(["trending", "ranging", "choppy", "transitional", "unclear"]),
  bias: z.enum(["bullish", "bearish", "neutral", "unclear"]),
  htf_structure: z.object({
    summary: z.string(),
    swing_points: z.string(),
    timeframe_relationships: z.string(),
  }),
  levels: z.array(PriceLevelSchema),
  levels_explanation: z.string(),
  liquidity: z.object({
    pools: z.array(LiquidityPoolSchema),
    sweeps: z.array(SweepSchema),
    summary: z.string(),
  }),
  structure: z.object({
    events: z.array(StructureEventSchema),
    shift_summary: z.string(),
  }),
  zones: z.array(ZoneSchema),
  fvgs: z.array(FvgSchema),
  order_blocks: z.array(OrderBlockSchema),
  order_block_note: z.string().describe("If no high-quality order block exists, say so here."),
  displacement: z.string(),
  breakout: z.object({
    classification: z.enum(["real", "potential_fake", "unconfirmed", "none"]),
    level_price: nullableNumber,
    evidence: z.string(),
  }),
  retest: z.string(),
  participant_inference: z.object({
    institutional_style: z.string(),
    retail_behaviour: z.string(),
  }),
  setup: SetupSchema,
  calibrations: z.array(CalibrationSchema),
  final_decision: z.enum(["potential_long", "potential_short", "no_trade_wait"]),
  summary: z.string(),
});

export type ChartAnalysis = z.infer<typeof ChartAnalysisSchema>;
export type ChartReading = z.infer<typeof ChartReadingSchema>;
export type PriceLevel = z.infer<typeof PriceLevelSchema>;
export type LiquidityPool = z.infer<typeof LiquidityPoolSchema>;
export type Sweep = z.infer<typeof SweepSchema>;
export type StructureEvent = z.infer<typeof StructureEventSchema>;
export type Zone = z.infer<typeof ZoneSchema>;
export type Fvg = z.infer<typeof FvgSchema>;
export type OrderBlock = z.infer<typeof OrderBlockSchema>;
export type Setup = z.infer<typeof SetupSchema>;
export type Calibration = z.infer<typeof CalibrationSchema>;
export type Grade = Setup["grade"];
export type FinalDecision = ChartAnalysis["final_decision"];
