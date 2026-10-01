import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import commonSchema from './schemas/common.schema.json';
import flagValueSchema from './schemas/flag_value.schema.json';
import flagConditionsSchema from './schemas/flag_conditions.schema.json';
import targetGroupConditionsSchema from './schemas/target_group_conditions.schema.json';
import flagConfigOptionalSchema from './schemas/flag_configuration_optional.schema.json';
import flagConfigSchema from './schemas/flag_configuration.schema.json';
import flagSchema from './schemas/flag.schema.json';
import targetGroupSchema from './schemas/target_group.schema.json';
import propertySchema from './schemas/property.schema.json';
import type { EntityKind, Finding } from './types';

const ENTITY_NAME_FIELD: Record<string, string> = {
  flag: 'flag',
  'flag-configuration': 'flag',
  'target-group': 'name',
  'flag-properties': 'name',
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// The flag-service schemas cross-reference each other by $id via $ref, so every
// schema in the dependency graph must be registered on the same Ajv instance
// before any of them is compiled, regardless of whether we validate against it
// directly.
for (const schema of [
  commonSchema,
  flagValueSchema,
  flagConditionsSchema,
  targetGroupConditionsSchema,
  flagConfigOptionalSchema,
]) {
  ajv.addSchema(schema);
}

const validators: Record<string, ValidateFunction> = {
  flag: ajv.compile(flagSchema),
  'flag-configuration': ajv.compile(flagConfigSchema),
  'target-group': ajv.compile(targetGroupSchema),
  'flag-properties': ajv.compile(propertySchema),
};

/** Converts ajv's "/conditions/0/flagValue" into the more readable "conditions[0].flagValue". */
function readablePath(instancePath: string): string {
  if (!instancePath) return '(document root)';
  return instancePath
    .slice(1)
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`))
    .join('')
    .replace(/^\./, '');
}

function formatAjvError(err: ErrorObject): string {
  const loc = readablePath(err.instancePath);
  switch (err.keyword) {
    case 'enum':
      return `${loc}: value is not one of the allowed values (${JSON.stringify((err.params as { allowedValues?: unknown[] }).allowedValues)})`;
    case 'required':
      return `${loc}: missing required field "${(err.params as { missingProperty: string }).missingProperty}"`;
    case 'additionalProperties':
      return `${loc}: unrecognized field "${(err.params as { additionalProperty: string }).additionalProperty}"`;
    case 'minLength':
      return `${loc}: value must not be empty`;
    case 'const':
      return `${loc}: value must be exactly ${JSON.stringify((err.params as { allowedValue: unknown }).allowedValue)}`;
    default:
      return `${loc}: ${err.message}`;
  }
}

export function validateAgainstSchema(
  kind: keyof typeof validators,
  doc: unknown,
  relPath: string,
): Finding[] {
  const validate = validators[kind];
  const valid = validate(doc);
  if (valid) return [];

  const nameField = ENTITY_NAME_FIELD[kind];
  const entityName =
    typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>)[nameField] : undefined;

  return (validate.errors ?? []).map((err) => ({
    severity: 'error' as const,
    file: relPath,
    rule: 'schema',
    message: formatAjvError(err),
    entityKind: kind as EntityKind,
    entityName: typeof entityName === 'string' && entityName.length > 0 ? entityName : undefined,
  }));
}
