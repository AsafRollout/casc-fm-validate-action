import { describe, expect, it } from 'vitest';
import { runValidateOnFiles, rulesOf } from './testUtils';

describe('string value on a number flag', () => {
  it('flags a string defaultValue on a number flag', () => {
    const summary = runValidateOnFiles({
      'flags/NumFlag.yaml': `
flag: NumFlag
flagType: number
`,
      'flag-configurations/production/NumFlag.config.yaml': `
flag: NumFlag
enabled: true
defaultValue: "str"
`,
    });
    expect(rulesOf(summary)).toContain('value-type-mismatch');
  });

  it('flags a split value whose options are all strings on a number flag', () => {
    // Note: a split array with mixed option types (string + number in the same
    // array) is rejected by the JSON Schema itself (ajv's anyOf requires every item
    // to match one single branch), so that case surfaces as a "schema" finding, not
    // "value-type-mismatch". This fixture uses internally-consistent string options
    // to isolate the business-rule check, which has no visibility into the schema
    // and must independently catch the type disagreeing with the flag's declared type.
    const summary = runValidateOnFiles({
      'flags/NumFlag.yaml': `
flag: NumFlag
flagType: number
`,
      'flag-configurations/production/NumFlag.config.yaml': `
flag: NumFlag
enabled: true
defaultValue: 1
conditions:
  - property:
      name: rox.environment
      operator: is-true
    flagValue:
      - percentage: 50
        option: "foo"
      - percentage: 50
        option: "bar"
`,
    });
    expect(rulesOf(summary)).toContain('value-type-mismatch');
  });
});

describe('number value on a boolean flag', () => {
  it('flags a numeric defaultValue on a boolean flag', () => {
    const summary = runValidateOnFiles({
      'flags/BoolFlag.yaml': `
flag: BoolFlag
flagType: boolean
`,
      'flag-configurations/production/BoolFlag.config.yaml': `
flag: BoolFlag
enabled: true
defaultValue: 3.14
`,
    });
    expect(rulesOf(summary)).toContain('value-type-mismatch');
  });
});

describe('target group condition referencing a non-existent property', () => {
  it('flags the missing property', () => {
    const summary = runValidateOnFiles({
      'target-groups/TgA.yaml': `
name: TgA
conditions:
  property:
    name: doesNotExist
    operator: is-true
`,
    });
    expect(rulesOf(summary)).toContain('missing-property');
  });
});

describe('flag configuration circular dependency (same environment, multi-level)', () => {
  it('flags a 3-level cycle A -> B -> C -> A within one environment', () => {
    const summary = runValidateOnFiles({
      'flags/FlagA.yaml': 'flag: FlagA\nflagType: boolean\n',
      'flags/FlagB.yaml': 'flag: FlagB\nflagType: boolean\n',
      'flags/FlagC.yaml': 'flag: FlagC\nflagType: boolean\n',
      'flag-configurations/production/FlagA.config.yaml': `
flag: FlagA
enabled: true
defaultValue: false
conditions:
  - flag:
      name: FlagB
      value: "true"
    flagValue: true
`,
      'flag-configurations/production/FlagB.config.yaml': `
flag: FlagB
enabled: true
defaultValue: false
conditions:
  - flag:
      name: FlagC
      value: "true"
    flagValue: true
`,
      'flag-configurations/production/FlagC.config.yaml': `
flag: FlagC
enabled: true
defaultValue: false
conditions:
  - flag:
      name: FlagA
      value: "true"
    flagValue: true
`,
    });
    expect(rulesOf(summary)).toContain('circular-flag-dependency');
  });

  it('does NOT flag the same flag names depending on each other across different environments', () => {
    const summary = runValidateOnFiles({
      'flags/FlagA.yaml': 'flag: FlagA\nflagType: boolean\n',
      'flags/FlagB.yaml': 'flag: FlagB\nflagType: boolean\n',
      'flag-configurations/production/FlagA.config.yaml': `
flag: FlagA
enabled: true
defaultValue: false
conditions:
  - flag:
      name: FlagB
      value: "true"
    flagValue: true
`,
      'flag-configurations/staging/FlagB.config.yaml': `
flag: FlagB
enabled: true
defaultValue: false
conditions:
  - flag:
      name: FlagA
      value: "true"
    flagValue: true
`,
    });
    expect(rulesOf(summary)).not.toContain('circular-flag-dependency');
  });
});

describe('target group circular dependency', () => {
  it('flags a direct 2-cycle TgA -> TgB -> TgA', () => {
    const summary = runValidateOnFiles({
      'target-groups/TgA.yaml': `
name: TgA
conditions:
  group:
    name: TgB
`,
      'target-groups/TgB.yaml': `
name: TgB
conditions:
  group:
    name: TgA
`,
    });
    expect(rulesOf(summary)).toContain('circular-target-group');
  });

  it('flags a target group that references itself directly', () => {
    const summary = runValidateOnFiles({
      'target-groups/TgSelf.yaml': `
name: TgSelf
conditions:
  group:
    name: TgSelf
`,
    });
    expect(rulesOf(summary)).toContain('circular-target-group');
  });
});

describe('bad YAML file', () => {
  it('flags a yaml-syntax error without crashing', () => {
    const summary = runValidateOnFiles({
      'flags/Broken.yaml': `
flag: Broken
  flagType: boolean
`,
    });
    expect(rulesOf(summary)).toContain('yaml-syntax');
  });
});

describe('empty entity names', () => {
  it('flags an empty flag name', () => {
    const summary = runValidateOnFiles({
      'flags/EmptyFlag.yaml': `
flag: ""
flagType: boolean
`,
    });
    expect(rulesOf(summary)).toContain('schema');
  });

  it('flags an empty target group name', () => {
    const summary = runValidateOnFiles({
      'target-groups/EmptyTg.yaml': `
name: ""
conditions:
  property:
    name: rox.environment
    operator: is-true
`,
    });
    expect(rulesOf(summary)).toContain('schema');
  });

  it('flags an empty property name', () => {
    const summary = runValidateOnFiles({
      'properties/EmptyProp.yaml': `
name: ""
type: String
`,
    });
    expect(rulesOf(summary)).toContain('schema');
  });
});
