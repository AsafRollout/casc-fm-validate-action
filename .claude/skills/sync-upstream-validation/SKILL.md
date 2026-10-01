---
name: sync-upstream-validation
description: Use when flag-service's CasC processing (ProcessCasc), its JSON schemas (pkg/model/schema), or casc-service's YAML models have changed, and this action's validation rules need to be updated to match. Also use when asked to "audit", "verify", or "re-check" this action's rules against upstream.
---

# Syncing casc-fm-validate-action with upstream validation logic

This action re-implements, in TypeScript, validation rules that are authoritatively
defined in two Go repos. It does **not** call those services at runtime (customers'
repos can't reach internal CloudBees infra from a public GitHub Action), so every rule
here is a manual port that can drift from upstream. This skill tells you where to look
when upstream changes and what in this repo to update in response.

## Ground truth, in priority order

1. **`flag-service`** `internal/service/{flag,flag_configuration,target_group,custom_property}.go`
   — the `Validate*Casc` functions (`ValidateFlagsCasc`, `ValidateFCsCasc`, `ValidateTGsCasc`,
   `ValidateCPsCasc`) are the actual code path CasC data goes through. This is the single
   most authoritative source — more authoritative than the JSON Schema files, which are
   NOT used in the CasC path (confirmed by grep: `schema.Validator` is only wired into
   `internal/api/flag_configuration.go` and `internal/api/target_group.go`, the regular
   REST/gRPC handlers, never into the CasC service layer).
2. **`flag-service`** `internal/api/intraplatform/casc_handler.go` — `ProcessCasc` /
   `ValidateAll` shows the call order: CPs → TGs → Flags → FCs. Each stage's state feeds
   the next (e.g. FC validation needs the already-validated TG/Flag/CP maps). This repo
   doesn't need to replicate the call order exactly since it validates a static file tree
   rather than a diff, but it matters for understanding *what* each stage can/can't see.
3. **`flag-service`** `pkg/model/{flag_value,flag_configuration,target_group_configuration}.go`
   — shared value-object validation: `FlagValue.Validate()` (split % sums to 100),
   `validateValue`/`validateValueMatchType` in `internal/service/flag_configuration.go`
   (type matching, schedule-values-are-boolean-only).
4. **`flag-service`** `pkg/model/conditions/*.go` — the condition type definitions
   (`PropertyCondition`, `GroupCondition`, `FlagCondition`, `NotCondition`,
   `CompoundCondition`). Field names/yaml tags here must match `src/schemas/*.json`.
5. **`flag-service`** `pkg/model/schema/*.schema.json` — JSON Schema for conditions,
   flag values, flag configuration shape. Only used by the non-CasC REST API, but the
   *shape* of `conditions`/`defaultValue` is identical in both paths, so these are a
   reliable source for schema shape even though they're not executed by `ProcessCasc`.
   NOTE: these reference target groups by `id` (uuid) — CasC YAML references them by
   `name` (string). This repo's `src/schemas/flag_conditions.schema.json` and
   `target_group_conditions.schema.json` are hand-adapted copies with `group.id` swapped
   for `group.name`. If upstream's `group` shape changes in any other way, re-apply the
   same swap rather than copying verbatim.
6. **`casc-service`** `internal/services/jobs/feature_management/*.go` (`flag_entity.go`,
   `flag_config_entity.go`, `target_group_entity.go`, `custom_prop_entity.go`) — the Go
   structs with `yaml:"..."` tags that are the actual source of truth for CasC YAML field
   names (e.g. `isPermanent`, `stickinessProperty`, `availableValues`). These are more
   reliable than the example fixtures in the same repo, which include known-stale/typo'd
   drafts (see Gotchas below).
6a. **`casc-service`** `internal/services/jobs/feature_management/*.tpl`
   (`flag.tpl`, `flag_config.tpl`, `custom_prop.tpl`, `target_group.tpl`) — the Go
   `text/template` files that generate the actual bytes written to each YAML file.
   **Read these alongside the struct files in (6), not instead of them.** The struct's
   `yaml:"..."` tag only governs *parsing* (what field name is accepted on read); the
   `.tpl` + its `GenerateYamlFile()` caller governs what CloudBees' own writer actually
   *produces* on disk, and the two can disagree in ways a schema derived only from (6)
   will miss. Concretely: `*_entity.go`'s `GenerateYamlFile()` usually formats each field
   by calling `toYaml()`/`yaml.Marshal()` (which correctly distinguishes an empty slice
   `[]` from a nil slice `null`), **except** `flag.tpl`'s `labels`/`availableValues`
   fields, which go through `arrayToYaml()` + a raw `{{ range .Labels }}` loop in the
   template instead — and Go's `range` over an empty/nil slice emits nothing, leaving a
   bare `labels:` key in the output file, which YAML parses as `null`, not `[]`. This is
   a real, observed-in-production shape (see cascProd1's `flags/blat6.yaml`, `f1.yaml`,
   `zero8.yaml` — all CloudBees-written, all with `labels:` and bare empty
   `availableValues:`), not a hypothetical edge case. **Lesson for next time:** when
   porting a field's schema, grep the relevant `.tpl` file for that field name and check
   whether it's inside a `{{ range }}`/raw-interpolation (null-when-empty risk) versus
   passed through a `toYaml()`-wrapped struct (safe). Don't infer "this field is an
   array, so empty will be `[]`" from the Go struct type alone — the template is the
   actual writer and can disagree with the type's natural zero value.
7. **`casc-service`** `pkg/fm/reference/fm-casc/.cloudbees/casc/feature-management/**`
   — real, clean example YAML files. Good for fixture-writing and sanity-checking field
   names. Do NOT trust `pkg/fm/reference/example-casc-files/*.yaml` (sibling directory,
   NOT under `fm-casc/`) — those contain intentional typos used in a different test
   (`isPerminant`, broken YAML indentation, `group: {id: ...}` instead of `name`).
8. **`common_proto`** `proto/flag_service/internal_api/casc/casc.proto` — the wire
   contract casc-service sends to flag-service. Useful for confirming field existence
   and types, but field names here are the *internal proto* names, not YAML names (yaml
   tags live in casc-service's Go structs, not here).

Clone locations on this machine (adjust if paths differ for whoever reads this later):
- `~/go/src/github.com/calculi-corp/flag-service`
- `~/go/src/github.com/calculi-corp/casc-service`
- `~/go/src/github.com/calculi-corp/common_proto`

If those repos aren't present locally, ask the user where they're checked out, or to
grant access — don't guess at validation rules from docs alone when the Go source is
the authority.

## What decides optional vs. mandatory in CasC YAML

There is no single schema or annotation that marks a field required/optional across
the whole system — it has to be derived from reading multiple places together, and
they can disagree (as the `labels`/`availableValues` bug above shows):

1. **What flag-service's `Validate*Casc` functions actually dereference without a nil
   check.** This is the real authority for "mandatory," since it's what will error at
   runtime. E.g. `ValidateFCsCasc` (`flag_configuration.go:1584`) unconditionally reads
   `fcUpdate.FlagName` and errors if the referenced flag doesn't exist — so `flag` is
   effectively mandatory on a flag-configuration. By contrast, `GetStickinessProperty()`,
   `GetSeed()` etc. are proto3 getters that return the zero value (`""`) on a nil/absent
   field with no error — so those are optional.
2. **The embedded JSON Schemas' `required` arrays** (`pkg/model/schema/*.schema.json`,
   e.g. `flag_configuration.schema.json`'s `"required": ["enabled", "defaultValue"]`).
   These only apply to the non-CasC REST API path (see point 1 in "Ground truth"
   above), but since the *shape* of `conditions`/`defaultValue` is shared, this is a
   reasonable secondary signal — just not authoritative for CasC specifically. This
   repo's own schemas (`src/schemas/*.json`) encode the `required` arrays we've chosen,
   and they are NOT a direct copy of the upstream `required` lists in every case (e.g.
   this repo requires `flag` on `flag-configuration`, which upstream's API-side
   `flag_configuration.schema.json` doesn't need to, since the API passes `flagId`
   out-of-band via the URL path rather than in the JSON body).
3. **Whether the Go struct field has `omitempty` in its `yaml:"..."` tag**
   (`*_entity.go` in casc-service). `omitempty` is a weak signal: it means the *writer*
   won't emit the field when empty, not that the *reader* requires it when present. Do
   not treat `omitempty`'s absence as proof a field is mandatory — cross-check against
   point 1.
4. **What the `.tpl` file unconditionally emits vs. omits.** A field written
   unconditionally (every CasC template writes every field it knows about, always) is
   not the same as that field being semantically required — it just means the file will
   always have the key present, possibly with an empty/null value, as this bug
   demonstrated. "Always present in the file" and "must have a non-empty value" are
   different claims; conflating them is exactly how the `labels: null` bug became a
   false positive.

In short: for "is X mandatory," trust the Go validation code's nil-checks (point 1)
over any schema's `required` list, and never infer requiredness from whether a
template happens to print the field.

## File-by-file map: upstream -> this repo

| Upstream rule / file | This repo | What to change |
|---|---|---|
| `flag-service` `pkg/model/schema/common.schema.json` | `src/schemas/common.schema.json` | Direct copy, no adaptation needed (operators are id-agnostic). Re-copy verbatim on upstream change. |
| `flag-service` `pkg/model/schema/flag_value.schema.json` | `src/schemas/flag_value.schema.json` | Direct copy. Re-copy verbatim on upstream change. |
| `flag-service` `pkg/model/schema/flag_conditions.schema.json` | `src/schemas/flag_conditions.schema.json` | Adapted: `group.id`(uuid) -> `group.name`(string). Re-apply this swap after re-copying. |
| `flag-service` `pkg/model/schema/target_group_conditions.schema.json` | `src/schemas/target_group_conditions.schema.json` | Same `group.id` -> `group.name` adaptation. |
| `flag-service` `pkg/model/schema/flag_configuration_optional.schema.json` | `src/schemas/flag_configuration_optional.schema.json` | Adapted: added `flag`/`kind`/`apiVersion` fields that exist in the CasC YAML wrapper but not the API-side schema. Re-check field list against `casc-service`'s `FlagConfig` struct (`flag_config_entity.go`), not the upstream API schema, when upstream changes. |
| No upstream file (hand-authored from proto + examples) | `src/schemas/flag.schema.json`, `target_group.schema.json`, `property.schema.json` | These don't exist as full-file JSON Schema upstream. Source of truth is `casc-service`'s `Flag`/`TargetGroup`/`CustomProperty` struct yaml tags + `casc.proto`. Update field lists if those structs change. |
| `flag.tpl`'s raw `{{ range }}` over `Labels`/`Variants` (bypasses `yaml.Marshal`, emits bare `labels:`/`availableValues:` key when empty) | `src/schemas/flag.schema.json` (`"type": ["array", "null"]` on both fields), `src/types.ts` `FlagDoc.labels`/`.availableValues` (typed `... | null`) | **Fixed after a real production false positive** on `AsafRollout/cascProd1` (flags `blat6`, `f1`, `zero8`, etc., all CloudBees-written). If `flag.tpl` is ever changed to marshal these fields properly (emitting `[]` instead of a bare key), this null-acceptance becomes merely harmless-but-unnecessary, not wrong — no need to revert it defensively, but it would be safe to. |
| `flag_value.go` `FlagValue.Validate()` (split % == 100) | `src/businessRules.ts` `checkFlagValue` (the `split-sum` rule) | Keep the `1e4` scale constant in sync — see the comment at `flag_value.go`'s `splitPercentageScale` for why float64 summing + rounding is used instead of exact comparison. |
| `flag_configuration.go` `validateValue` (schedule values boolean-only) | `src/businessRules.ts` `checkFlagValue` (the `schedule-requires-boolean` rule) | If upstream relaxes this to other flag types, update the `flagType !== 'boolean'` check. |
| `flag_configuration.go` `validateValueMatchType` | `src/businessRules.ts` `checkFlagValue` (the `value-type-mismatch` rule) | Upstream switches on Go's `int`/`float32`/`bool`/`string` — JS has no int/float split, `typeof` is sufficient. |
| `target_group.go` `validateTGConditionInternal` (TG referencing non-existent property/group) | `src/crossReference.ts` `checkCrossReferences` (`missing-property`, `missing-target-group` for target-groups) | Mirror any new condition type upstream adds to the `switch` statement. |
| `target_group.go` `visitTG`/`validateTGDependenciesAndUpdateNameToIds` (TG cycle detection) | `src/crossReference.ts` `checkTargetGroupCycles` | Global graph across all target groups — upstream also treats TGs as app-global (not per-environment), so this matches. |
| `flag_configuration.go` `validateFCConditionInternal` (FC referencing non-existent flag/property/group) | `src/crossReference.ts` `checkCrossReferences` (the flag-config loop) | Same per-condition-type mirroring as TGs. |
| `flag_configuration.go` `validateSdkKeyFCsDependenciesAndUpdateNameToIds` (flag cycle detection, **reset per SDK key**) | `src/crossReference.ts` `checkFlagCycles` | IMPORTANT: this is scoped **per environment**, not global — upstream resets `visited`/`validated` for each SDK key (= each environment). A flag referencing itself across two different environments is NOT a cycle. This repo's `checkFlagCycles` groups `flagConfigs` by `fc.environment` before building each graph — do not flatten this back to one global graph. |
| `custom_property.go` `validateCPChanges` (type cannot change) | NOT IMPLEMENTED — requires live DB state (the property's current type in CloudBees) that a GitHub Action has no access to. If asked to add this, it's not possible without an API call to CloudBees from the Action, which is a different scope of change (see "Known limitations" below). |
| `flag.go` `validateFlagChanges` (flag type cannot change) | NOT IMPLEMENTED — same reason as above. |
| Docs-only: built-in properties (`rox.distinct_id`, `rox.environment`, `rox.application`, `version`) | `src/types.ts` `BUILTIN_PROPERTY_NAMES` | **UNVERIFIED against Go source** — no code found in flag-service or casc-service that special-cases these names; property conditions are checked only against registered `CustomProperty` entities. Kept because the public docs assert it. If you find the actual seeding/allowlist code, update this comment to cite it directly; if you find evidence it's wrong, remove entries and tighten `missing-property`. |

## Deliberately NOT implemented (confirmed absent upstream, don't add without re-verifying)

These were explicitly checked against the Go source (not just "not gotten to yet") and
found to have no corresponding runtime validation. Adding a check for them would make
this action stricter than flag-service itself and reject YAML that CloudBees' own
backend accepts — a false positive, not a safety improvement.

- **`stickinessProperty` referencing an undefined custom property.** Checked
  `updateDBFCFromCasc` (`flag_configuration.go` ~line 1986-1992): `StickynessProperty`
  is copied verbatim from the CasC payload with no existence check against registered
  `CustomProperty` entities, unlike `property` conditions (which **are** checked via
  `validateFCConditionInternal`). If this ever starts being validated upstream, add a
  `missing-property`-style check scoped to `stickinessProperty` specifically.
- **Split/flagValue `option` values not in a flag's `availableValues` (= Go field
  `Variants`).** `availableValues` in CasC YAML is the same concept as `variants` in
  flag-service's Go code (`fsPb.Flag.Variants`, `casc.Flag.Variants`) — confirmed via
  `flag_entity.go`'s yaml tag `Variants []string \`yaml:"availableValues"\``. It is
  **never a validation gate** in either the regular API or CasC, but the two paths
  diverge in an important way:
  - Regular (non-CasC) API: `AddValuesToFlagVariants` (`flag_configuration.go:1518`,
    called from `UpsertFlagConfiguration` — singular, the per-flag API path, see line
    1044) runs *after* a successful upsert and auto-grows `variants` to include any new
    value found in `defaultValue`/conditions. So "value not in variants" can't actually
    happen via the API — the API makes `variants` follow the real values instead of
    constraining them.
  - CasC path: `UpsertFlagConfigurations` (plural, called from `casc_handler.go`,
    confirmed by grep: `AddValuesToFlagVariants` has zero callers outside
    `UpsertFlagConfiguration` singular) does **not** call `AddValuesToFlagVariants` at
    all. So via CasC, `availableValues` is not auto-grown either — it can silently drift
    out of sync with the real `defaultValue`/condition values and nothing anywhere
    complains, including this action.
  Net effect: adding an "option must be in availableValues" check to this action would
  not just be stricter than upstream, it would actively flag CasC files that are in a
  state upstream itself allows to exist indefinitely (stale `availableValues`). Do not
  add this check unless flag-service starts enforcing it, since that would mean
  "stale/wrong availableValues" becomes an actual bug class worth catching.

## Known limitations (don't try to fix these without a scope discussion first)

- **No access to live FM state.** This action validates the YAML tree in isolation. It
  cannot check things that require the current CloudBees org state: flag/property type
  immutability (`validateFlagChanges`, `validateCPChanges`), MAU capacity
  (`CheckMauCapacity`), or whether an environment name in `flag-configurations/<env>/`
  actually exists as a configured environment in the org. Implementing these would
  require the Action to call a CloudBees API with credentials — a materially different
  (and more invasive) design than a pure static-file check. Flag this explicitly to the
  user if asked to add such a rule; don't silently skip it.
- **Approval requests, ghost configs, hierarchy/sub-org inheritance** are DB/runtime
  concepts in flag-service with no YAML representation to validate against.

## How to do the sync, step by step

1. Ask the user (or check `git log` in the upstream repos) what actually changed —
   don't re-derive the whole rule set from scratch each time.
2. Find the corresponding row in the file-by-file map above.
3. Read the changed upstream function/schema in full before editing anything here —
   the Go validation functions often have subtle scoping (see the per-environment flag
   cycle example) that's easy to miss from a diff alone.
4. Update the corresponding TS file or vendored schema.
5. Add or update a fixture under a scratch directory (see testing approach below) that
   exercises the new/changed rule, both a passing and a failing case.
6. Run `npm run typecheck && npm run build`, then smoke-test with the fixture:
   ```
   cd /path/to/fixture-root
   INPUT_PATH=".cloudbees/casc" node /path/to/casc-fm-validate-action/dist/index.js
   ```
7. Update this SKILL.md's table if the upstream file location itself moved, so the next
   sync doesn't start from a stale map.

## Testing approach

`src/__tests__/testUtils.ts` exports `runValidateOnFiles(files)` — pass a map of
CasC-relative paths (e.g. `"flags/MyFlag.yaml"`) to YAML content, it writes them to a
throwaway temp dir under the right `.cloudbees/casc/feature-management/...` structure,
runs `validate()`, cleans up, and returns the `ValidateSummary`. `rulesOf(summary)`
extracts just the rule names for a quick `toContain()` assertion.

`src/__tests__/scenarios.test.ts` has one `describe` block per validated scenario, each
with the minimal fixture needed to trigger (or deliberately NOT trigger) a specific
finding. When adding a new rule, add a test here in the same style — a failing-case
test asserting the rule fires, and when the rule has subtle scoping (e.g. the
per-environment flag cycle), a second test asserting it does NOT fire in the case that
looks similar but shouldn't match.

Run `cd casc-fm-validate-action && npx vitest run`. Note: `vitest`/`vite` search
upward from the repo root for config files (`vitest.config.*`, `postcss.config.*`) —
if the parent directories contain unrelated projects with their own configs, vitest can
pick those up by mistake and fail to start. This repo's `vitest.config.ts` sets
`test.root` and an empty `css.postcss.plugins` array specifically to prevent that; if
vitest fails with a "Cannot find package" or "Invalid PostCSS Plugin" error unrelated to
this repo's code, that's the upward-search problem recurring, not a real bug here.

For manual/exploratory smoke-testing outside vitest, the same `validate()` function can
be driven directly, or build + run the Action binary against a real directory:
```
npm run build
cd /path/to/some/fixture-root   # must contain .cloudbees/casc/feature-management/...
INPUT_PATH=".cloudbees/casc" "INPUT_FAIL-ON-WARNING=false" node /path/to/casc-fm-validate-action/dist/index.js
```
A real known-good baseline tree is available by copying `casc-service`'s
`pkg/fm/reference/fm-casc/.cloudbees` directory — useful for checking a new rule
doesn't false-positive on CloudBees' own reference example.
