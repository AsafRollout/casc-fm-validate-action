import { BUILTIN_PROPERTY_NAMES, type CascTree, type Finding, type FlagConfigEntity } from './types';

type ConditionNode = Record<string, unknown>;

function collectPropertyAndGroupAndFlagRefs(
  node: unknown,
  out: { properties: string[]; groups: string[]; flags: string[] },
): void {
  if (Array.isArray(node)) {
    node.forEach((n) => collectPropertyAndGroupAndFlagRefs(n, out));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const c = node as ConditionNode;

  if (c.property && typeof c.property === 'object') {
    const name = (c.property as Record<string, unknown>).name;
    if (typeof name === 'string') out.properties.push(name);
  }
  if (c.group && typeof c.group === 'object') {
    const name = (c.group as Record<string, unknown>).name;
    if (typeof name === 'string') out.groups.push(name);
  }
  if (c.flag && typeof c.flag === 'object') {
    const name = (c.flag as Record<string, unknown>).name;
    if (typeof name === 'string') out.flags.push(name);
  }
  if (Array.isArray(c.allOf)) collectPropertyAndGroupAndFlagRefs(c.allOf, out);
  if (Array.isArray(c.anyOf)) collectPropertyAndGroupAndFlagRefs(c.anyOf, out);
  if (c.not) collectPropertyAndGroupAndFlagRefs(c.not, out);
}

function directGroupRefs(conditions: unknown): string[] {
  const out = { properties: [] as string[], groups: [] as string[], flags: [] as string[] };
  collectPropertyAndGroupAndFlagRefs(conditions, out);
  return out.groups;
}

/**
 * Checks that every name referenced by a `group`, `property`, or `flag` condition
 * actually exists as a defined entity, and that flag/flag-configuration/target-group
 * names are each unique within their own kind. Also detects target-group -> target-group
 * and flag -> flag circular references via DFS, mirroring flag-service's
 * internal/service/validation/validation_state.go.
 */
export function checkCrossReferences(tree: CascTree): Finding[] {
  const findings: Finding[] = [];

  const flagNames = new Set(tree.flags.map((f) => f.doc.flag));
  const tgNames = new Set(tree.targetGroups.map((tg) => tg.doc.name));
  const propNames = new Set(tree.properties.map((p) => p.doc.name));

  // Duplicate name detection within each entity kind.
  checkDuplicates(
    tree.flags.map((f) => ({ name: f.doc.flag, file: f.file.relPath })),
    'flag',
    findings,
  );
  checkDuplicates(
    tree.targetGroups.map((tg) => ({ name: tg.doc.name, file: tg.file.relPath })),
    'target-group',
    findings,
  );
  checkDuplicates(
    tree.properties.map((p) => ({ name: p.doc.name, file: p.file.relPath })),
    'flag-properties',
    findings,
  );

  // flag-configurations: flag name must exist, and no two configs for the same
  // flag+environment.
  const seenFlagEnv = new Map<string, string>();
  for (const fc of tree.flagConfigs) {
    if (!flagNames.has(fc.doc.flag)) {
      findings.push({
        severity: 'error',
        file: fc.file.relPath,
        rule: 'missing-flag',
        message: `flag-configuration references flag "${fc.doc.flag}" which does not exist in flags/`,
        entityKind: 'flag-configuration',
        entityName: fc.doc.flag,
      });
    }
    const key = `${fc.environment}::${fc.doc.flag}`;
    const existing = seenFlagEnv.get(key);
    if (existing) {
      findings.push({
        severity: 'error',
        file: fc.file.relPath,
        rule: 'duplicate-flag-config',
        message: `duplicate flag-configuration for flag "${fc.doc.flag}" in environment "${fc.environment}" (also defined in ${existing})`,
        entityKind: 'flag-configuration',
        entityName: fc.doc.flag,
      });
    } else {
      seenFlagEnv.set(key, fc.file.relPath);
    }

    const refs = { properties: [] as string[], groups: [] as string[], flags: [] as string[] };
    collectPropertyAndGroupAndFlagRefs(fc.doc.conditions, refs);
    reportMissingRefs(refs, { flagNames, tgNames, propNames }, {
      file: fc.file.relPath,
      entityKind: 'flag-configuration',
      entityName: fc.doc.flag,
    }, findings);
  }

  // target-groups: nested group/property refs must exist.
  for (const tg of tree.targetGroups) {
    const refs = { properties: [] as string[], groups: [] as string[], flags: [] as string[] };
    collectPropertyAndGroupAndFlagRefs(tg.doc.conditions, refs);
    reportMissingRefs(refs, { flagNames, tgNames, propNames }, {
      file: tg.file.relPath,
      entityKind: 'target-group',
      entityName: tg.doc.name,
    }, findings);
  }

  checkTargetGroupCycles(tree, findings);
  checkFlagCycles(tree, findings);

  return findings;
}

function checkDuplicates(
  items: Array<{ name: string; file: string }>,
  kind: 'flag' | 'target-group' | 'flag-properties',
  findings: Finding[],
): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    const existing = seen.get(item.name);
    if (existing) {
      findings.push({
        severity: 'error',
        file: item.file,
        rule: 'duplicate-name',
        message: `duplicate ${kind} name "${item.name}" (also defined in ${existing})`,
        entityKind: kind,
        entityName: item.name,
      });
    } else {
      seen.set(item.name, item.file);
    }
  }
}

interface RefCtx {
  file: string;
  entityKind: 'flag-configuration' | 'target-group';
  entityName: string;
}

function reportMissingRefs(
  refs: { properties: string[]; groups: string[]; flags: string[] },
  known: { flagNames: Set<string>; tgNames: Set<string>; propNames: Set<string> },
  ctx: RefCtx,
  findings: Finding[],
): void {
  for (const name of new Set(refs.properties)) {
    if (!known.propNames.has(name) && !BUILTIN_PROPERTY_NAMES.has(name)) {
      findings.push({
        severity: 'error',
        file: ctx.file,
        rule: 'missing-property',
        message: `condition references property "${name}" which is not defined in properties/ and is not a built-in property`,
        entityKind: ctx.entityKind,
        entityName: ctx.entityName,
      });
    }
  }
  for (const name of new Set(refs.groups)) {
    if (!known.tgNames.has(name)) {
      findings.push({
        severity: 'error',
        file: ctx.file,
        rule: 'missing-target-group',
        message: `condition references target group "${name}" which does not exist in target-groups/`,
        entityKind: ctx.entityKind,
        entityName: ctx.entityName,
      });
    }
  }
  for (const name of new Set(refs.flags)) {
    if (!known.flagNames.has(name)) {
      findings.push({
        severity: 'error',
        file: ctx.file,
        rule: 'missing-flag',
        message: `condition references flag "${name}" which does not exist in flags/`,
        entityKind: ctx.entityKind,
        entityName: ctx.entityName,
      });
    }
  }
}

/** Generic DFS cycle detector over a name -> [referenced names] graph. */
function findCycle(graph: Map<string, string[]>): string[] | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  function visit(node: string): string[] | undefined {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const cycleStart = stack.indexOf(next);
        return [...stack.slice(cycleStart), next];
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return undefined;
  }

  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return undefined;
}

function checkTargetGroupCycles(tree: CascTree, findings: Finding[]): void {
  const graph = new Map<string, string[]>();
  const fileByName = new Map<string, string>();
  for (const tg of tree.targetGroups) {
    fileByName.set(tg.doc.name, tg.file.relPath);
    graph.set(tg.doc.name, directGroupRefs(tg.doc.conditions));
  }

  const cycle = findCycle(graph);
  if (cycle) {
    const file = fileByName.get(cycle[0]) ?? tree.targetGroups[0]?.file.relPath ?? '';
    findings.push({
      severity: 'error',
      file,
      rule: 'circular-target-group',
      message: `circular target-group reference: ${cycle.join(' -> ')}`,
      entityKind: 'target-group',
      entityName: cycle[0],
    });
  }
}

/**
 * Flag -> flag conditions only form a dependency within the same environment (an
 * environment maps 1:1 to an SDK key server-side), so flag-service's
 * validateSdkKeyFCsDependenciesAndUpdateNameToIds resets its visited/validated sets
 * per SDK key rather than checking one global graph. A flag referencing itself across
 * two different environments is not a cycle and must not be flagged as one.
 */
function checkFlagCycles(tree: CascTree, findings: Finding[]): void {
  const byEnv = new Map<string, FlagConfigEntity[]>();
  for (const fc of tree.flagConfigs) {
    const env = fc.environment ?? '';
    const list = byEnv.get(env) ?? [];
    list.push(fc);
    byEnv.set(env, list);
  }

  for (const [, configs] of byEnv) {
    const graph = new Map<string, string[]>();
    const fileByName = new Map<string, string>();
    for (const fc of configs) {
      fileByName.set(fc.doc.flag, fc.file.relPath);
      const refs = { properties: [] as string[], groups: [] as string[], flags: [] as string[] };
      collectPropertyAndGroupAndFlagRefs(fc.doc.conditions, refs);
      const existing = graph.get(fc.doc.flag) ?? [];
      graph.set(fc.doc.flag, [...existing, ...refs.flags]);
    }

    const cycle = findCycle(graph);
    if (cycle) {
      const file = fileByName.get(cycle[0]) ?? configs[0]?.file.relPath ?? '';
      findings.push({
        severity: 'error',
        file,
        rule: 'circular-flag-dependency',
        message: `circular flag dependency in environment "${configs[0]?.environment}": ${cycle.join(' -> ')}`,
        entityKind: 'flag-configuration',
        entityName: cycle[0],
      });
    }
  }
}
