import * as core from '@actions/core';
import { resolveCascRoot, validate } from './validate';
import type { Finding } from './types';

function entityLabel(f: Finding): string {
  if (!f.entityKind) return '';
  const kindLabel: Record<string, string> = {
    flag: 'flag',
    'flag-configuration': 'flag-configuration',
    'target-group': 'target-group',
    'flag-properties': 'property',
  };
  const kind = kindLabel[f.entityKind] ?? f.entityKind;
  return f.entityName ? ` [${kind}: ${f.entityName}]` : ` [${kind}]`;
}

/** One line per finding for the plain job log: "#N [severity] file (rule) [entity]: message". */
function formatLine(index: number, f: Finding): string {
  return `#${index} [${f.severity.toUpperCase()}] ${f.file} (${f.rule})${entityLabel(f)}: ${f.message}`;
}

function reportToAnnotations(findings: Finding[]): void {
  findings.forEach((f, i) => {
    const props = {
      file: f.file,
      title: `#${i + 1} casc-fm-validate: ${f.rule}`,
      startLine: f.line,
    };
    const message = `${f.message}${entityLabel(f)}`;
    if (f.severity === 'error') {
      core.error(message, props);
    } else {
      core.warning(message, props);
    }
  });
}

function reportToLog(findings: Finding[]): void {
  if (findings.length === 0) {
    core.info('casc-fm-validate: no issues found.');
    return;
  }
  core.info(`casc-fm-validate: ${findings.length} issue(s) found:`);
  findings.forEach((f, i) => core.info('  ' + formatLine(i + 1, f)));
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

async function writeJobSummary(
  findings: Finding[],
  counts: { flagCount: number; flagConfigCount: number; targetGroupCount: number; propertyCount: number },
): Promise<void> {
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  core.summary.addHeading('CloudBees Feature Management CasC Validation', 2);
  core.summary.addRaw(
    `Checked **${counts.flagCount}** flag(s), **${counts.flagConfigCount}** flag-configuration(s), ` +
      `**${counts.targetGroupCount}** target-group(s), **${counts.propertyCount}** property(ies).\n\n`,
  );

  if (findings.length === 0) {
    core.summary.addRaw('✅ No issues found.\n');
  } else {
    core.summary.addRaw(`${errorCount > 0 ? '❌' : '⚠️'} **${errorCount} error(s), ${warningCount} warning(s)**\n\n`);
    const rows = findings.map((f, i) => [
      String(i + 1),
      f.severity === 'error' ? '❌ error' : '⚠️ warning',
      `\`${escapeMd(f.file)}\``,
      f.rule,
      f.entityName ? `${f.entityKind ?? ''}: ${escapeMd(f.entityName)}` : '',
      escapeMd(f.message),
    ]);
    core.summary.addTable([
      [
        { data: '#', header: true },
        { data: 'Severity', header: true },
        { data: 'File', header: true },
        { data: 'Rule', header: true },
        { data: 'Entity', header: true },
        { data: 'Message', header: true },
      ],
      ...rows,
    ]);
  }

  await core.summary.write();
}

async function run(): Promise<void> {
  const cascRelPath = core.getInput('path') || '.cloudbees/casc';
  const failOnWarning = core.getBooleanInput('fail-on-warning');
  const repoRoot = process.cwd();
  const cascRoot = resolveCascRoot(repoRoot, cascRelPath);

  const summary = validate(cascRoot, repoRoot);

  reportToLog(summary.findings);
  reportToAnnotations(summary.findings);
  await writeJobSummary(summary.findings, summary);

  const errorCount = summary.findings.filter((f) => f.severity === 'error').length;
  const warningCount = summary.findings.filter((f) => f.severity === 'warning').length;

  core.setOutput('errors-count', errorCount);
  core.setOutput('warnings-count', warningCount);

  if (errorCount > 0 || (failOnWarning && warningCount > 0)) {
    core.setFailed(`CasC validation failed with ${errorCount} error(s) and ${warningCount} warning(s)`);
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
