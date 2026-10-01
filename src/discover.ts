import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type {
  CascTree,
  EntityKind,
  FlagConfigEntity,
  FlagEntity,
  Finding,
  PropertyEntity,
  SourceFile,
  TargetGroupEntity,
} from './types';

function listYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listYamlFiles(full));
    } else if (/\.(ya?ml)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function readSourceFile(repoRoot: string, absPath: string): SourceFile {
  return {
    relPath: path.relative(repoRoot, absPath),
    absPath,
    raw: fs.readFileSync(absPath, 'utf8'),
  };
}

/**
 * Parses one YAML file. Returns either the parsed doc or a syntax-error Finding.
 * CasC files use multiple `---`-separated documents in some fixtures, but FM entities
 * are always exactly one document per file.
 */
function parseYaml(file: SourceFile, findings: Finding[]): any | undefined {
  try {
    const doc = yaml.load(file.raw);
    if (doc === undefined || doc === null) {
      findings.push({
        severity: 'error',
        file: file.relPath,
        rule: 'yaml-syntax',
        message: 'File is empty or contains no YAML document',
      });
      return undefined;
    }
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      findings.push({
        severity: 'error',
        file: file.relPath,
        rule: 'yaml-syntax',
        message: 'Top-level YAML content must be a mapping (object)',
      });
      return undefined;
    }
    return doc;
  } catch (err) {
    const mark = (err as yaml.YAMLException)?.mark;
    findings.push({
      severity: 'error',
      file: file.relPath,
      rule: 'yaml-syntax',
      message: `Invalid YAML syntax: ${(err as Error).message}`,
      line: mark ? mark.line + 1 : undefined,
    });
    return undefined;
  }
}

export interface DiscoverResult {
  tree: CascTree;
  findings: Finding[];
}

interface DirSpec {
  dirName: string;
  kind: EntityKind;
  nameField: 'flag' | 'name';
}

const DIR_SPECS: DirSpec[] = [
  { dirName: 'flags', kind: 'flag', nameField: 'flag' },
  { dirName: 'target-groups', kind: 'target-group', nameField: 'name' },
  { dirName: 'properties', kind: 'flag-properties', nameField: 'name' },
];

function parseEntitiesInDir<TDoc>(
  fmRoot: string,
  repoRoot: string,
  spec: DirSpec,
  findings: Finding[],
): Array<{ file: SourceFile; doc: TDoc }> {
  const out: Array<{ file: SourceFile; doc: TDoc }> = [];
  for (const absPath of listYamlFiles(path.join(fmRoot, spec.dirName))) {
    const file = readSourceFile(repoRoot, absPath);
    const doc = parseYaml(file, findings);
    if (!doc) continue;
    const entityName = typeof doc[spec.nameField] === 'string' ? doc[spec.nameField] : undefined;
    if (doc.kind && doc.kind !== spec.kind) {
      findings.push({
        severity: 'error',
        file: file.relPath,
        rule: 'kind-mismatch',
        message: `File is under ${spec.dirName}/ but declares kind: "${doc.kind}" (expected "${spec.kind}")`,
        entityKind: spec.kind,
        entityName,
      });
      continue;
    }
    out.push({ file, doc });
  }
  return out;
}

/**
 * Walks the CasC feature-management directory tree and parses every YAML file into
 * its typed entity bucket. Files with the wrong `kind` for their directory, or that
 * fail to parse, produce findings but do not stop the walk - we want one PR run to
 * surface every problem, not just the first.
 */
export function discoverCascTree(cascRoot: string, repoRoot: string): DiscoverResult {
  const findings: Finding[] = [];
  const fmRoot = path.join(cascRoot, 'feature-management');

  const flagsRaw = parseEntitiesInDir<FlagEntity['doc']>(fmRoot, repoRoot, DIR_SPECS[0], findings);
  const flags: FlagEntity[] = flagsRaw.map(({ file, doc }) => ({ kind: 'flag', file, doc }));

  const targetGroupsRaw = parseEntitiesInDir<TargetGroupEntity['doc']>(fmRoot, repoRoot, DIR_SPECS[1], findings);
  const targetGroups: TargetGroupEntity[] = targetGroupsRaw.map(({ file, doc }) => ({
    kind: 'target-group',
    file,
    doc,
  }));

  const propertiesRaw = parseEntitiesInDir<PropertyEntity['doc']>(fmRoot, repoRoot, DIR_SPECS[2], findings);
  const properties: PropertyEntity[] = propertiesRaw.map(({ file, doc }) => ({
    kind: 'flag-properties',
    file,
    doc,
  }));

  const flagConfigs: FlagConfigEntity[] = [];
  const flagConfigsRoot = path.join(fmRoot, 'flag-configurations');
  if (fs.existsSync(flagConfigsRoot)) {
    for (const envEntry of fs.readdirSync(flagConfigsRoot, { withFileTypes: true })) {
      if (!envEntry.isDirectory()) continue;
      const envDir = path.join(flagConfigsRoot, envEntry.name);
      for (const absPath of listYamlFiles(envDir)) {
        const file = readSourceFile(repoRoot, absPath);
        const doc = parseYaml(file, findings);
        if (!doc) continue;
        const entityName = typeof doc.flag === 'string' ? doc.flag : undefined;
        if (doc.kind && doc.kind !== 'flag-configuration') {
          findings.push({
            severity: 'error',
            file: file.relPath,
            rule: 'kind-mismatch',
            message: `File is under flag-configurations/ but declares kind: "${doc.kind}" (expected "flag-configuration")`,
            entityKind: 'flag-configuration',
            entityName,
          });
          continue;
        }
        flagConfigs.push({ kind: 'flag-configuration', file, doc, environment: envEntry.name });
      }
    }
  }

  return { tree: { flags, flagConfigs, targetGroups, properties }, findings };
}
