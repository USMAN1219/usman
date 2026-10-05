/** Renders a completed analysis in the fixed 13-section report format. */
import type { ChartAnalysis } from "../../shared/analysis-schema.ts";
import type { AnalysisRecord, DerivedAnalysis } from "../../shared/types.ts";
import { fmtMoney, fmtPrice, fmtRange, fmtRr, titleCase } from "../lib/format.ts";
import { ConfidenceBadge, DecisionBadge, GradeBadge, WatchBadge } from "./Badges.tsx";
import { Disclaimer } from "./Disclaimer.tsx";

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="report-section">
      <h3>
        <span className="sec-n">{n}.</span> {title}
      </h3>
      {children}
    </section>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

const tfTag = (tf: string | null) => (tf ? <span className="tag">{tf}</span> : null);
const Empty = ({ text }: { text: string }) => <p className="muted small">{text}</p>;

export function AnalysisReport({ record }: { record: AnalysisRecord }) {
  const a = record.result as ChartAnalysis;
  const d = record.derived as DerivedAnalysis;
  const s = a.setup;
  const support = a.levels.filter((l) => l.kind === "support");
  const resistance = a.levels.filter((l) => l.kind === "resistance");
  const bsl = a.liquidity.pools.filter((p) => /high/.test(p.type));
  const ssl = a.liquidity.pools.filter((p) => /low/.test(p.type));
  const other = a.liquidity.pools.filter((p) => !/high|low/.test(p.type));
  const bos = a.structure.events.filter((e) => e.type === "BOS");
  const choch = a.structure.events.filter((e) => e.type === "CHOCH");
  const demand = a.zones.filter((z) => z.kind === "demand");
  const supply = a.zones.filter((z) => z.kind === "supply");
  const overridden = d.finalDecision !== d.aiFinalDecision || d.guardrailNotes.length > 0;
  const currency = d.sizing.currency ?? "USD";

  return (
    <article className="report">
      <header className="report-head card">
        <h2>AI Market Analysis</h2>
        <div className="kv-grid">
          <KV k="Symbol" v={a.symbol ?? record.symbol ?? "Not readable"} />
          <KV k="Current price" v={fmtPrice(a.current_price)} />
          <KV k="Timeframe(s)" v={a.timeframes.length ? a.timeframes.join(" · ") : "Unclear"} />
          <KV k="Market condition" v={titleCase(a.market_condition)} />
          <KV k="Bias" v={titleCase(a.bias)} />
        </div>
        <div className="row gap-s wrap">
          <DecisionBadge decision={d.finalDecision} large />
          <GradeBadge grade={d.grade} />
          <ConfidenceBadge confidence={s.confidence} />
          {s.trade_style && <span className="badge neutral">{titleCase(s.trade_style)}</span>}
          <WatchBadge status={d.watchStatus} />
        </div>
        <p className="summary">{a.summary}</p>
        {(a.readability_issues.length > 0 || a.charts.some((c) => c.issues.length)) && (
          <div className="alert warn small">
            <strong>What the AI could not read clearly:</strong>
            <ul>
              {a.readability_issues.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
              {a.charts.flatMap((c) => c.issues.map((x, i) => <li key={`${c.image_index}-${i}`}>Image {c.image_index + 1}: {x}</li>))}
            </ul>
          </div>
        )}
        {!a.same_instrument && <div className="alert warn small">The screenshots appear to show different instruments; see the structure section for which one was analysed.</div>}
        {d.complianceWarnings.length > 0 && (
          <div className="alert warn small">
            <strong>Review these statements carefully:</strong>
            <ul>
              {d.complianceWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </header>

      <Section n={1} title="Higher-Timeframe Structure">
        <p>{a.htf_structure.summary}</p>
        <p className="small">
          <strong>Swings:</strong> {a.htf_structure.swing_points}
        </p>
        <p className="small">
          <strong>Timeframe relationships:</strong> {a.htf_structure.timeframe_relationships}
        </p>
      </Section>

      <Section n={2} title="Important Levels">
        <div className="grid-2">
          <div>
            <h4>Support</h4>
            {support.length ? (
              <ul className="items">
                {support.map((l, i) => (
                  <li key={i}>
                    <strong>{fmtRange(l.price, l.price_high)}</strong> {tfTag(l.timeframe)} {l.importance === "major" && <span className="tag strong">major</span>}
                    <div className="small muted">{l.reason}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text="No meaningful support identified." />
            )}
          </div>
          <div>
            <h4>Resistance</h4>
            {resistance.length ? (
              <ul className="items">
                {resistance.map((l, i) => (
                  <li key={i}>
                    <strong>{fmtRange(l.price, l.price_high)}</strong> {tfTag(l.timeframe)} {l.importance === "major" && <span className="tag strong">major</span>}
                    <div className="small muted">{l.reason}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text="No meaningful resistance identified." />
            )}
          </div>
        </div>
        <p className="small">{a.levels_explanation}</p>
      </Section>

      <Section n={3} title="Liquidity">
        <div className="grid-2">
          {[
            ["Buy-side liquidity", bsl],
            ["Sell-side liquidity", ssl],
          ].map(([title, list]) => (
            <div key={title as string}>
              <h4>{title as string}</h4>
              {(list as typeof bsl).length ? (
                <ul className="items">
                  {(list as typeof bsl).map((p, i) => (
                    <li key={i}>
                      <strong>{fmtPrice(p.price)}</strong> <span className="tag">{titleCase(p.type)}</span> <span className="tag">{p.scope}</span>{" "}
                      <span className={`tag status-${p.status}`}>{titleCase(p.status)}</span>
                      <div className="small muted">{p.description}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty text="None identified." />
              )}
            </div>
          ))}
        </div>
        {other.length > 0 && (
          <ul className="items">
            {other.map((p, i) => (
              <li key={i}>
                <strong>{fmtPrice(p.price)}</strong> <span className={`tag status-${p.status}`}>{titleCase(p.status)}</span> <span className="small muted">{p.description}</span>
              </li>
            ))}
          </ul>
        )}
        <h4>Liquidity sweep</h4>
        {a.liquidity.sweeps.length ? (
          <ul className="items">
            {a.liquidity.sweeps.map((sw, i) => (
              <li key={i}>
                <strong>{sw.side === "buy_side" ? "Buy-side" : "Sell-side"} sweep at {fmtPrice(sw.price)}</strong> {tfTag(sw.timeframe)}{" "}
                <span className="tag">{sw.rejection_strength} rejection</span>
                <div className="small muted">{sw.description}</div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text="No meaningful liquidity sweep identified." />
        )}
        <p className="small">{a.liquidity.summary}</p>
      </Section>

      <Section n={4} title="Market Structure">
        {[
          ["BOS", bos],
          ["CHOCH", choch],
        ].map(([title, list]) => (
          <div key={title as string}>
            <h4>{title as string}</h4>
            {(list as typeof bos).length ? (
              <ul className="items">
                {(list as typeof bos).map((e, i) => (
                  <li key={i}>
                    <strong>
                      {titleCase(e.direction)} {e.type}
                      {e.level_price != null ? ` at ${fmtPrice(e.level_price)}` : ""}
                    </strong>{" "}
                    {tfTag(e.timeframe)} <span className="tag">{e.strength}</span> {e.displacement && <span className="tag">displacement</span>}{" "}
                    {e.after_liquidity_event && <span className="tag">after liquidity event</span>}
                    <div className="small muted">{e.description}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text={`No meaningful ${title as string} identified.`} />
            )}
          </div>
        ))}
        <p className="small">
          <strong>Structure shift:</strong> {a.structure.shift_summary}
        </p>
        <p className="small">
          <strong>Displacement:</strong> {a.displacement}
        </p>
      </Section>

      <Section n={5} title="Supply & Demand">
        <div className="grid-2">
          {[
            ["Demand", demand],
            ["Supply", supply],
          ].map(([title, list]) => (
            <div key={title as string}>
              <h4>{title as string}</h4>
              {(list as typeof demand).length ? (
                <ul className="items">
                  {(list as typeof demand).map((z, i) => (
                    <li key={i}>
                      <strong>{fmtRange(z.price_low, z.price_high)}</strong> {tfTag(z.timeframe)} <GradeBadge grade={z.grade === "weak" ? "C" : z.grade} />{" "}
                      {z.grade === "weak" && <span className="tag">weak / ignore</span>} <span className="tag">{z.fresh ? "fresh" : "tested"}</span>
                      <div className="small muted">{z.reason}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty text="No high-quality zone identified." />
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section n={6} title="Fair Value Gap">
        {a.fvgs.length ? (
          <ul className="items">
            {a.fvgs.map((f, i) => (
              <li key={i}>
                <strong>
                  {titleCase(f.direction)} FVG {fmtRange(f.price_low, f.price_high)}
                </strong>{" "}
                {tfTag(f.timeframe)} <span className={`tag status-${f.status}`}>Status: {titleCase(f.status)}</span>
                <div className="small muted">{f.context}</div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text="No meaningful FVG identified." />
        )}
      </Section>

      <Section n={7} title="Order Block">
        {a.order_blocks.length ? (
          <ul className="items">
            {a.order_blocks.map((ob, i) => (
              <li key={i}>
                <strong>
                  {titleCase(ob.direction)} OB {fmtRange(ob.price_low, ob.price_high)}
                </strong>{" "}
                {tfTag(ob.timeframe)} <span className="tag">Quality: {ob.quality}</span> <span className="tag">Status: {titleCase(ob.status)}</span>
                <div className="small muted">{ob.reason}</div>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="small">{a.order_block_note}</p>
      </Section>

      <Section n={8} title="Breakout Analysis">
        <p>
          <span className={`badge breakout-${a.breakout.classification}`}>
            {{ real: "Real breakout", potential_fake: "Potential fake breakout", unconfirmed: "Unconfirmed", none: "No breakout in play" }[a.breakout.classification]}
          </span>
          {a.breakout.level_price != null && <span className="small"> at {fmtPrice(a.breakout.level_price)}</span>}
        </p>
        <p className="small">{a.breakout.evidence}</p>
        <p className="small">
          <strong>Retest:</strong> {a.retest}
        </p>
        <p className="small muted">
          <strong>Institutional-style inference:</strong> {a.participant_inference.institutional_style}
        </p>
        <p className="small muted">
          <strong>Retail behaviour (chart-based inference):</strong> {a.participant_inference.retail_behaviour}
        </p>
      </Section>

      <Section n={9} title="Potential Trade Setup">
        {overridden && d.guardrailNotes.length > 0 && (
          <div className="alert warn small">
            <strong>Safety checks changed the decision to NO TRADE — WAIT:</strong>
            <ul>
              {d.guardrailNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="setup-grid">
          <KV k="Direction" v={s.direction === "no_trade" ? "NO TRADE" : s.direction.toUpperCase()} />
          <KV k="Entry type" v={s.entry_type ? titleCase(s.entry_type) : "—"} />
          <KV k="Entry zone" v={fmtRange(s.entry_low, s.entry_high)} />
          <KV k="Stop loss" v={fmtPrice(s.stop_loss)} />
          <KV k="TP1" v={`${fmtPrice(s.tp1)}${d.rr?.tp1 != null ? `  (${fmtRr(d.rr.tp1)})` : ""}`} />
          <KV k="TP2" v={`${fmtPrice(s.tp2)}${d.rr?.tp2 != null ? `  (${fmtRr(d.rr.tp2)})` : ""}`} />
          <KV k="TP3" v={`${fmtPrice(s.tp3)}${d.rr?.tp3 != null ? `  (${fmtRr(d.rr.tp3)})` : ""}`} />
          <KV k="Potential R:R" v={<>{fmtRr(d.rr?.primary)} {d.meetsMinRr === false && <span className="tag bad">below your 1:{d.settingsUsed.minRr}</span>}</>} />
          <KV k="Setup quality" v={<GradeBadge grade={d.grade} />} />
          <KV k="Trade style" v={s.trade_style ? titleCase(s.trade_style) : "—"} />
        </div>
        {d.rr && (
          <p className="tiny muted">
            R:R is computed by the app from the entry-zone midpoint ({fmtPrice(d.entryRef)}) and stop distance ({fmtPrice(d.riskPerUnit)}). Primary target = TP2 when
            present, else TP1.
          </p>
        )}
        {s.stop_reason && (
          <p className="small">
            <strong>Stop placement:</strong> {s.stop_reason}
          </p>
        )}
        {s.target_reasons.length > 0 && (
          <ul className="small">
            {s.target_reasons.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        )}
        <div className="sizing">
          <h4>Risk management</h4>
          {d.sizing.available ? (
            <p>
              Risking <strong>{fmtMoney(d.sizing.riskAmount, currency)}</strong> → approx. <strong>{d.sizing.units}</strong> units/lots/contracts.
            </p>
          ) : (
            <p className="small">{d.sizing.note}</p>
          )}
          {d.sizing.available && <p className="tiny muted">{d.sizing.note}</p>}
          <p className="tiny muted">Recommended: risk about 0.5%–1% of your account per trade. Never average down, revenge-trade or use martingale sizing.</p>
        </div>
      </Section>

      <Section n={10} title="Why This Setup?">
        <p>{s.why}</p>
        {s.confluence.length > 0 && (
          <ul className="checklist">
            {s.confluence.map((c, i) => (
              <li key={i} className={c.present ? "yes" : "no"}>
                <span aria-hidden>{c.present ? "✓" : "✗"}</span> <strong>{c.factor}</strong>
                {c.note && <span className="small muted"> — {c.note}</span>}
              </li>
            ))}
          </ul>
        )}
        {s.no_trade_reasons.length > 0 && (
          <>
            <h4>Reasons not to trade</h4>
            <ul className="small">
              {s.no_trade_reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section n={11} title="Invalidation">
        <p>{s.invalidation}</p>
      </Section>

      <Section n={12} title="What Should I Wait For?">
        {s.requires_confirmation && <p className="wait-banner">WAIT FOR CONFIRMATION</p>}
        <p>{s.wait_for}</p>
      </Section>

      <Section n={13} title="Final Decision">
        <DecisionBadge decision={d.finalDecision} large />
        {d.aiFinalDecision !== d.finalDecision && (
          <p className="small muted">The AI proposed “{titleCase(d.aiFinalDecision)}”; the app's safety checks changed it (see section 9).</p>
        )}
        <p className="small muted">
          Confidence describes how clear the chart evidence is — it is not a probability that the trade will win. You make the final decision.
        </p>
        <Disclaimer />
      </Section>
    </article>
  );
}
