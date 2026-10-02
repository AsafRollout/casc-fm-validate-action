# CasC Feature Management Validator

A GitHub Action that validates [CloudBees Feature Management Configuration-as-Code
(CasC)](https://docs.cloudbees.com/docs/cloudbees-unify/latest/feature-management/reference/configuration-as-code-reference)
YAML files before they're merged.

CloudBees Feature Management can sync flags, flag configurations, target groups, and
custom properties to a `.cloudbees/casc/feature-management/` directory in your
repository, and changes made there sync back into Feature Management. This action
catches structural, business-rule, and cross-reference problems in that directory
*before* a bad change merges — things like a flag value that doesn't match its
declared type, a condition referencing a target group or property that doesn't exist,
or a circular dependency between flags or target groups.

## Usage

Add a workflow that runs on pull requests touching the CasC directory:

```yaml
# .github/workflows/casc-validate.yml
name: Validate CasC

on:
  pull_request:
    paths:
      - '.cloudbees/casc/feature-management/**'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: AsafRollout/casc-fm-validate-action@v1
```

Findings are reported three ways in the same run: inline PR annotations on the
offending file/line, a numbered list in the job log, and a markdown table in the job
summary (visible at the top of the PR's checks tab). The job fails if any error is
found.

### Requiring this check before merge

If CloudBees' CasC integration writes directly to your default branch (no PR), you
likely want this check to run only for human-authored changes, while still letting
CloudBees' own writes through. That's a two-part setup:

1. Add a [repository ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
   on your default branch requiring a pull request before merging.
2. Add CloudBees' GitHub App (`cloudbees-platform[bot]`) as a bypass actor on that
   ruleset, so its direct commits aren't blocked.
3. Mark this action's check as a required status check on the same ruleset, so a PR
   can't merge while it's failing.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `path` | No | `.cloudbees/casc` | Repo-root-relative path containing the CasC tree (the directory that contains `feature-management/`). |
| `fail-on-warning` | No | `false` | Treat warnings as failures. |

## Outputs

| Output | Description |
|---|---|
| `errors-count` | Number of validation errors found. |
| `warnings-count` | Number of validation warnings found. |

## What it checks

- **YAML syntax** — every file under `flags/`, `flag-configurations/<env>/`,
  `target-groups/`, and `properties/` must parse, and the top-level `kind:` must match
  its directory.
- **Schema shape** — required/allowed fields per entity type (flag, flag-configuration,
  target-group, property), condition structure (`property`/`group`/`flag`/`not`/`allOf`/`anyOf`),
  and flag-value shape (plain value, percentage split, or scheduled rollout).
- **Business rules** — split/schedule percentages must sum to exactly 100; a plain or
  split value's type must match the flag's declared `flagType`; schedule values
  (`from`) are only valid on boolean flags.
- **Cross-references** — a `flag-configuration`'s `flag` must exist in `flags/`; a
  condition's `group`/`property`/`flag` reference must exist; no two
  `flag-configuration` files may target the same flag in the same environment; flag and
  target-group names must be unique within their kind.
- **Circular dependencies** — target-group → target-group cycles (checked globally),
  and flag → flag cycles via `flag` conditions (checked **per environment**, matching
  how CloudBees evaluates dependencies — the same flag names depending on each other in
  two different environments is not a cycle).

A few rules you might expect are deliberately **not** enforced — e.g. a flag value that
isn't in that flag's `availableValues` list — because CloudBees' own backend doesn't
enforce them either. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full reasoning if
you're curious why.

## Versioning

Tagged releases follow semver (`v0.1.0`, `v0.1.1`, ...). The moving `v1` tag always
points at the latest `v1.x.y` commit — most workflows should pin to `@v1` to get fixes
automatically. Pin to an exact tag or commit SHA instead if you need fully reproducible
builds.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to build, test, and extend this
action, including where its validation rules come from upstream.
