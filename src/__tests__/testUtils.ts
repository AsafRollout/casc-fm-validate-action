import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validate, type ValidateSummary } from '../validate';

/**
 * Writes a map of CasC-relative paths (e.g. "flags/MyFlag.yaml") to a fresh temp
 * directory under a ".cloudbees/casc/feature-management" root, then runs validate()
 * against it. Returns the summary plus a cleanup function.
 */
export function runValidateOnFiles(files: Record<string, string>): ValidateSummary {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'casc-fm-validate-test-'));
  const fmRoot = path.join(repoRoot, '.cloudbees', 'casc', 'feature-management');

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(fmRoot, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  const cascRoot = path.join(repoRoot, '.cloudbees', 'casc');
  const summary = validate(cascRoot, repoRoot);

  fs.rmSync(repoRoot, { recursive: true, force: true });
  return summary;
}

export function rulesOf(summary: ValidateSummary): string[] {
  return summary.findings.map((f) => f.rule);
}
