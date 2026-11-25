/**
 * Agent-only list of fields to verify for a live quote run. Shows a one-line
 * count; the full list stays behind a "See details" toggle, collapsed by
 * default.
 */
export function agentVerificationSummary(count: number): string {
  return `An agent will verify ${count} ${count === 1 ? "detail" : "details"} for this quote.`;
}

export default function AgentVerificationSummary({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null;
  return (
    <div
      className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950"
      data-testid="agent-verification"
    >
      <strong className="block">Agent-only verification</strong>
      <p className="mt-0.5" data-testid="agent-verification-summary">
        {agentVerificationSummary(fields.length)}
      </p>
      <details className="mt-1" data-testid="agent-verification-details">
        <summary className="cursor-pointer font-semibold">See details</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {fields.map(field => (
            <li key={field}>{field}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
