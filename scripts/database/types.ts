import type { IInsertIncidentParams, IInsertIncidentResult } from './incidents.queries.js';

// Compile-only assertions prove the generator's boundary rather than hand-written types.
const valid: IInsertIncidentParams = { id: 'uuid', summary: 'Timeout', details: null };
void valid;

// @ts-expect-error Required SQL parameters cannot be omitted.
const missingSummary: IInsertIncidentParams = { id: 'uuid' };
void missingSummary;

// @ts-expect-error A text parameter must not accept a number.
const wrongSummary: IInsertIncidentParams = { id: 'uuid', summary: 12 };
void wrongSummary;

function inspectResult(row: IInsertIncidentResult) {
  const details: string | null = row.details;
  const timestamp: Date = row.created_at;
  // @ts-expect-error Nullable SQL text must be narrowed before using it as a string.
  const nonNullable: string = row.details;
  void [details, timestamp, nonNullable];
}
void inspectResult;
