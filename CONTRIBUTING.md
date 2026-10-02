# Contributing

This is a Node/TypeScript GitHub Action. It validates a static YAML tree
(`.cloudbees/casc/feature-management/`) against rules ported from CloudBees'
`flag-service` and `casc-service` Go repos — it does not call those services at
runtime, since a public GitHub Action can't reach internal CloudBees infra. That means
every rule here is a manual port that can silently drift from upstream behavior.

**Before changing or adding a validation rule, read
[`.claude/skills/sync-upstream-validation/SKILL.md`](.claude/skills/sync-upstream-validation/SKILL.md).**
It documents exactly which upstream Go file/function each rule is derived from, a
file-by-file map of what to update when upstream changes, and — importantly — which
checks were deliberately *not* implemented because CloudBees' own backend doesn't
enforce them either (adding them would make this action stricter than CloudBees itself
and reject YAML that CloudBees accepts). That skill file also has a real example of a
production false positive (a CasC-writer quirk around `labels`/`availableValues`
rendering as YAML `null` instead of an empty array) and how it was found and fixed —
useful context for how to investigate the next one.

## Setup

```bash
npm install
```

## Development loop

```bash
npm run typecheck   # tsc --noEmit
npx vitest run       # unit tests
npm run build        # compiles src/ to dist/index.js
```

`dist/index.js` is checked into the repo — GitHub Actions runs the compiled JS
directly, not the TypeScript source — so **any `src/` change must be followed by
`npm run build` and committing the result.** CI (`.github/workflows/ci.yml`) runs
typecheck, tests, and build on every push/PR, and fails if `dist/` doesn't match a
fresh build of `src/`, so a forgotten rebuild won't silently merge.

## Tests

`src/__tests__/scenarios.test.ts` has one `describe` block per validated scenario.
Each test calls `runValidateOnFiles()` (`src/__tests__/testUtils.ts`), which writes an
in-memory map of CasC-relative paths (e.g. `"flags/MyFlag.yaml"`) to YAML content into
a throwaway temp directory with the right `.cloudbees/casc/feature-management/...`
structure, runs the real `validate()` function against it, and cleans up.

When adding a new rule:
- Add a failing-case test asserting the rule fires (`rulesOf(summary)).toContain(...)`).
- If the rule has non-obvious scoping (e.g. the per-environment flag-cycle check), add
  a second test confirming it does **not** fire in a similar-looking case that
  shouldn't match. Several existing rules have exactly this shape — see the "circular
  dependency" and "cross-environment" tests for examples.

Run with:
```bash
npx vitest run
```

Note: `vitest`/`vite` search upward from the repo root for config files
(`vitest.config.*`, `postcss.config.*`). If parent directories on your machine contain
unrelated projects with their own configs, vitest can pick those up by mistake and fail
to start with an unrelated-looking error (`Cannot find package ...`, `Invalid PostCSS
Plugin`). This repo's `vitest.config.ts` sets `test.root` and an empty
`css.postcss.plugins` specifically to prevent that — if you hit either error, that's
the upward-search problem recurring, not a bug in this repo's code.

## Manual / exploratory testing

To run the compiled action against a real directory outside of vitest:

```bash
npm run build
cd /path/to/some/fixture-root   # must contain .cloudbees/casc/feature-management/...
INPUT_PATH=".cloudbees/casc" node /path/to/casc-fm-validate-action/dist/index.js
```

A real known-good baseline tree is available by copying `casc-service`'s
`pkg/fm/reference/fm-casc/.cloudbees` directory from CloudBees' own repo — useful for
checking a new rule doesn't false-positive on CloudBees' own reference example.

## Releasing

Tag a new version and move the major tag forward so existing consumers pinned to
`@v1` pick it up automatically:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z

git tag -f v1
git push origin v1 --force
```

Only move `v1` after `npm run typecheck && npx vitest run && npm run build` all pass
and `dist/` is committed — anyone pinned to `@v1` gets this immediately on their next
workflow run.
