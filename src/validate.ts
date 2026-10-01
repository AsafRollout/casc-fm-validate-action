import * as path from 'path';
import { discoverCascTree } from './discover';
import { validateAgainstSchema } from './schemaValidate';
import { checkBusinessRules } from './businessRules';
import { checkCrossReferences } from './crossReference';
import type { Finding } from './types';

export interface ValidateSummary {
  findings: Finding[];
  flagCount: number;
  flagConfigCount: number;
  targetGroupCount: number;
  propertyCount: number;
}

/**
 * Pure validation entry point: given a CasC root directory on disk, returns every
 * Finding across all layers (YAML syntax, JSON Schema, business rules, cross-reference).
 * No side effects (no @actions/core calls) - this is what index.ts wraps for the
 * Action runtime, and what tests call directly.
 */
export function validate(cascRoot: string, repoRoot: string): ValidateSummary {
  const { tree, findings: parseFindings } = discoverCascTree(cascRoot, repoRoot);

  const schemaFindings: Finding[] = [
    ...tree.flags.flatMap((f) => validateAgainstSchema('flag', f.doc, f.file.relPath)),
    ...tree.flagConfigs.flatMap((fc) => validateAgainstSchema('flag-configuration', fc.doc, fc.file.relPath)),
    ...tree.targetGroups.flatMap((tg) => validateAgainstSchema('target-group', tg.doc, tg.file.relPath)),
    ...tree.properties.flatMap((p) => validateAgainstSchema('flag-properties', p.doc, p.file.relPath)),
  ];

  // Business-rule and cross-reference checks assume schema-valid shapes for the
  // fields they inspect; running them on malformed docs would produce confusing
  // secondary errors, so entities with a schema failure are excluded from the
  // more advanced checks below (the schema error itself is still reported).
  const badFiles = new Set(schemaFindings.map((f) => f.file));
  const cleanTree = {
    flags: tree.flags.filter((f) => !badFiles.has(f.file.relPath)),
    flagConfigs: tree.flagConfigs.filter((f) => !badFiles.has(f.file.relPath)),
    targetGroups: tree.targetGroups.filter((f) => !badFiles.has(f.file.relPath)),
    properties: tree.properties.filter((f) => !badFiles.has(f.file.relPath)),
  };

  const businessFindings = checkBusinessRules(cleanTree);
  const crossRefFindings = checkCrossReferences(cleanTree);

  return {
    findings: [...parseFindings, ...schemaFindings, ...businessFindings, ...crossRefFindings],
    flagCount: tree.flags.length,
    flagConfigCount: tree.flagConfigs.length,
    targetGroupCount: tree.targetGroups.length,
    propertyCount: tree.properties.length,
  };
}

export function resolveCascRoot(repoRoot: string, cascRelPath: string): string {
  return path.join(repoRoot, cascRelPath);
}
