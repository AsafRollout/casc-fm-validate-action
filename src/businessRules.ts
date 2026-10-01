import type { CascTree, Finding, FlagConfigEntity, FlagDoc } from './types';

/** Matches flag-service's splitPercentageScale: compare sums to 4 decimal places. */
const SPLIT_PERCENTAGE_SCALE = 1e4;

interface SplitOrScheduleItem {
  percentage?: number;
  option?: unknown;
  from?: unknown;
}

interface EntityCtx {
  file: string;
  entityName: string;
}

function isValueWrittenInCode(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).valueWrittenInCode === true
  );
}

function flagValueTypeName(flagType: FlagDoc['flagType']): string {
  switch (flagType) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string':
    default:
      return 'string';
  }
}

function pushFinding(findings: Finding[], ctx: EntityCtx, rule: string, message: string): void {
  findings.push({
    severity: 'error',
    file: ctx.file,
    rule,
    message,
    entityKind: 'flag-configuration',
    entityName: ctx.entityName,
  });
}

/**
 * Validates that a flagValue (defaultValue, or a condition's flagValue) is internally
 * consistent: split/schedule percentages sum to 100 (mirrors flag-service's
 * FlagValue.Validate), and plain/option values match the flag's declared type.
 */
function checkFlagValue(
  value: unknown,
  context: string,
  flagType: FlagDoc['flagType'] | undefined,
  ctx: EntityCtx,
  findings: Finding[],
): void {
  if (value === undefined || value === null) return;
  if (isValueWrittenInCode(value)) return;

  if (Array.isArray(value)) {
    const items = value as SplitOrScheduleItem[];
    if (items.length === 0) {
      pushFinding(findings, ctx, 'split-empty', `${context}: split/schedule value array must not be empty`);
      return;
    }

    const hasOption = items.some((i) => i.option !== undefined);
    const hasFrom = items.some((i) => i.from !== undefined);
    if (hasOption && hasFrom) {
      pushFinding(
        findings,
        ctx,
        'split-mixed',
        `${context}: cannot mix split ("option") and schedule ("from") entries`,
      );
    }

    // Mirrors flag-service's validateValue: only boolean flags support schedule values.
    if (hasFrom && flagType && flagType !== 'boolean') {
      pushFinding(
        findings,
        ctx,
        'schedule-requires-boolean',
        `${context}: schedule values ("from") are only supported for boolean flags, flag type is "${flagType}"`,
      );
    }

    if (hasOption && flagType) {
      const expected = flagValueTypeName(flagType);
      for (const [i, item] of items.entries()) {
        if (item.option !== undefined && typeof item.option !== expected) {
          pushFinding(
            findings,
            ctx,
            'value-type-mismatch',
            `${context}[${i}].option: value ${JSON.stringify(item.option)} does not match flag type "${flagType}" (expected ${expected})`,
          );
        }
      }
    }

    const sum = items.reduce((acc, i) => acc + (typeof i.percentage === 'number' ? i.percentage : 0), 0);
    if (Math.round(sum * SPLIT_PERCENTAGE_SCALE) !== 100 * SPLIT_PERCENTAGE_SCALE) {
      pushFinding(findings, ctx, 'split-sum', `${context}: sum of percentages (${sum}) does not equal 100, must equal exactly 100`);
    }
    return;
  }

  // Plain value - check it matches the flag's declared type, when known.
  if (flagType) {
    const expected = flagValueTypeName(flagType);
    if (typeof value !== expected) {
      pushFinding(
        findings,
        ctx,
        'value-type-mismatch',
        `${context}: value ${JSON.stringify(value)} does not match flag type "${flagType}" (expected ${expected})`,
      );
    }
  }
}

function walkConditionsForFlagValues(
  conditions: unknown,
  flagType: FlagDoc['flagType'] | undefined,
  ctx: EntityCtx,
  findings: Finding[],
  pathLabel = 'conditions',
): void {
  if (!Array.isArray(conditions)) return;
  conditions.forEach((cond, idx) => {
    if (typeof cond !== 'object' || cond === null) return;
    const c = cond as Record<string, unknown>;
    const label = `${pathLabel}[${idx}]`;
    if ('flagValue' in c) {
      checkFlagValue(c.flagValue, `${label}.flagValue`, flagType, ctx, findings);
    }
    if (Array.isArray(c.allOf)) walkConditionsForFlagValues(c.allOf, flagType, ctx, findings, `${label}.allOf`);
    if (Array.isArray(c.anyOf)) walkConditionsForFlagValues(c.anyOf, flagType, ctx, findings, `${label}.anyOf`);
    if (c.not && typeof c.not === 'object') {
      walkConditionsForFlagValues([c.not], flagType, ctx, findings, `${label}.not`);
    }
  });
}

/**
 * Runs the business rules that flag-service enforces in Go code rather than JSON
 * Schema: split/schedule percentage sums, and default/condition value type agreement
 * with the flag's declared flagType. Requires the flag's type, so this must run
 * after flags are indexed by name (see crossReference.ts for how the lookup is built).
 */
export function checkBusinessRules(tree: CascTree): Finding[] {
  const findings: Finding[] = [];
  const flagTypeByName = new Map<string, FlagDoc['flagType']>();
  for (const f of tree.flags) {
    flagTypeByName.set(f.doc.flag, f.doc.flagType ?? 'boolean');
  }

  const checkConfig = (fc: FlagConfigEntity) => {
    const flagType = flagTypeByName.get(fc.doc.flag);
    const ctx: EntityCtx = { file: fc.file.relPath, entityName: fc.doc.flag };
    checkFlagValue(fc.doc.defaultValue, 'defaultValue', flagType, ctx, findings);
    walkConditionsForFlagValues(fc.doc.conditions, flagType, ctx, findings);
  };

  tree.flagConfigs.forEach(checkConfig);

  return findings;
}
