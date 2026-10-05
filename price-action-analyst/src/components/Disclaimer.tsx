export const DISCLAIMER_TEXT =
  "AI analysis is probabilistic and may be wrong. Always independently verify the chart before taking any trade.";

export function Disclaimer({ compact = false }: { compact?: boolean }) {
  return (
    <p className={compact ? "disclaimer compact" : "disclaimer"} role="note">
      ⚠️ {DISCLAIMER_TEXT}
    </p>
  );
}
