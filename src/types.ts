export type EntityKind = 'flag' | 'flag-configuration' | 'target-group' | 'flag-properties';

export interface SourceFile {
  /** Path relative to the repo root, used in error annotations */
  relPath: string;
  /** Absolute path on disk */
  absPath: string;
  /** Raw YAML text */
  raw: string;
}

export interface ParsedEntity<TKind extends EntityKind, TDoc> {
  kind: TKind;
  file: SourceFile;
  doc: TDoc;
  /** The environment directory name, only set for flag-configuration */
  environment?: string;
}

export interface FlagDoc {
  flag: string;
  flagType?: 'boolean' | 'string' | 'number';
  description?: string;
  /** CloudBees' CasC writer emits a bare `labels:` key (YAML null) when there are no labels, see flag.tpl. */
  labels?: string[] | null;
  /** Same null-when-empty quirk as labels, see flag.tpl's raw `{{ range }}` over Variants. */
  availableValues?: Array<string | number> | null;
  isPermanent?: boolean;
}

export interface FlagConfigDoc {
  flag: string;
  enabled?: boolean;
  stickinessProperty?: string;
  seed?: string;
  defaultValue?: unknown;
  conditions?: unknown[];
}

export interface TargetGroupDoc {
  name: string;
  description?: string;
  conditions?: unknown;
}

export interface PropertyDoc {
  name: string;
  type: 'Boolean' | 'String' | 'Semver' | 'Number' | 'Datetime';
  description?: string;
}

export type FlagEntity = ParsedEntity<'flag', FlagDoc>;
export type FlagConfigEntity = ParsedEntity<'flag-configuration', FlagConfigDoc>;
export type TargetGroupEntity = ParsedEntity<'target-group', TargetGroupDoc>;
export type PropertyEntity = ParsedEntity<'flag-properties', PropertyDoc>;

export interface CascTree {
  flags: FlagEntity[];
  flagConfigs: FlagConfigEntity[];
  targetGroups: TargetGroupEntity[];
  properties: PropertyEntity[];
}

export type Severity = 'error' | 'warning';

export interface Finding {
  severity: Severity;
  file: string;
  message: string;
  /** 1-based line number, if known */
  line?: number;
  rule: string;
  /** The kind of entity this finding is about, e.g. "flag", "target-group". Omitted if the file failed to parse before its kind could be determined. */
  entityKind?: EntityKind;
  /** The entity's declared name (flag/target-group/property name), when known. */
  entityName?: string;
}

/**
 * Built-in properties available without an explicit properties/*.yaml definition,
 * per the public CasC reference docs. UNVERIFIED against flag-service/casc-service
 * source: no code path there special-cases these names - property conditions are
 * checked only against registered CustomProperty entities (see
 * validateFCConditionInternal / validateTGConditionInternal in flag-service). If a
 * false negative shows up in practice (one of these rejected as "missing-property"),
 * remove it here; if ProcessCasc is ever found to special-case these, that's the
 * authoritative source - update this list to match exactly.
 */
export const BUILTIN_PROPERTY_NAMES = new Set([
  'rox.distinct_id',
  'rox.environment',
  'rox.application',
  'version',
]);
