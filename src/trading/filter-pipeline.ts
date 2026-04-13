import { FilterConfig } from './config';

export interface FilterStageResult {
  label: string;
  field: string;
  operator: string;
  threshold: string;
  actualValue: number | null;
  passed: boolean;
}

export interface FilterPipelineResult {
  passed: boolean;
  /** Label of the first failing filter, or null if all passed */
  failedFilter: string | null;
  /** Actual value of the first failing field, or null */
  failedValue: number | null;
  /** Full audit trail — every filter evaluated up to and including first failure */
  stages: FilterStageResult[];
}

/**
 * Evaluate a set of filter configs against a graduation_momentum row.
 *
 * Logic: AND — short-circuits on first failure.
 * Null field value = FAIL (conservative: missing data → don't trade).
 *
 * Mirrors the predicate() functions in PANEL_1_FILTERS (src/index.ts:1902–2021).
 *
 * NOTE: buy_pressure_* fields are written at T+35 (not T+30). Strategies
 * with buy_pressure filters are automatically delayed 5s by StrategyManager
 * so these fields are populated before evaluation.
 */
export function runFilterPipeline(
  row: Record<string, unknown>,
  filters: FilterConfig[],
): FilterPipelineResult {
  const stages: FilterStageResult[] = [];

  for (const f of filters) {
    const raw = row[f.field];
    const actualValue = raw == null ? null : Number(raw);
    let passed = false;

    if (actualValue !== null && !isNaN(actualValue)) {
      switch (f.operator) {
        case '>=': passed = actualValue >= f.value; break;
        case '<=': passed = actualValue <= f.value; break;
        case '>':  passed = actualValue >  f.value; break;
        case '<':  passed = actualValue <  f.value; break;
        case '==': passed = actualValue === f.value; break;
        case '!=': passed = actualValue !== f.value; break;
      }
    }

    stages.push({
      label: f.label,
      field: f.field,
      operator: f.operator,
      threshold: `${f.operator}${f.value}`,
      actualValue,
      passed,
    });

    if (!passed) {
      return {
        passed: false,
        failedFilter: f.label,
        failedValue: actualValue,
        stages,
      };
    }
  }

  return { passed: true, failedFilter: null, failedValue: null, stages };
}
