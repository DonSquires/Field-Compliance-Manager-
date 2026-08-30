const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  changedFilesFromPatch,
  validatePatchText,
  PROTECTED_FRONTEND_PATHS
} = require('./frontend-worker');

const MAX_REPORT_BYTES = 512 * 1024;
const RULES = [
  {
    id: 'credential-material',
    severity: 'critical',
    pattern: /(?:BEGIN [A-Z ]*PRIVATE KEY|SUPABASE_SERVICE_ROLE_KEY\s*[:=]|(?:api[_-]?key|token|password|secret)\s*[:=]\s*['"][^'"]{8,}|\bsk-[A-Za-z0-9_-]{16,})/i,
    message: 'Possible credential material added to frontend source'
  },
  {
    id: 'dynamic-code-execution',
    severity: 'high',
    pattern: /(?:\beval\s*\(|\bnew\s+Function\s*\(|\bdocument\.write\s*\()/,
    message: 'Dynamic browser code execution added'
  },
  {
    id: 'unsafe-html-injection',
    severity: 'high',
    pattern: /dangerouslySetInnerHTML/,
    message: 'Raw HTML injection requires explicit security review'
  },
  {
    id: 'sensitive-browser-storage',
    severity: 'high',
    pattern: /(?:localStorage|sessionStorage)\.setItem\s*\([^\n]*(?:token|secret|password|credential)/i,
    message: 'Sensitive value written to browser storage'
  },
  {
    id: 'insecure-http-endpoint',
    severity: 'medium',
    pattern: /http:\/\/(?!localhost|127\.0\.0\.1)/i,
    message: 'Insecure HTTP endpoint added'
  }
];

function addedLinesByFile(patchText) {
  const lines = patchText.split('\n');
  const added = [];
  let file = null;
  let targetLine = 0;
  for (const line of lines) {
    const diff = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diff) {
      file = diff[2];
      targetLine = 0;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      targetLine = Number(hunk[1]);
      continue;
    }
    if (!file || line.startsWith('+++')) continue;
    if (line.startsWith('+')) {
      added.push({ file, line: targetLine, content: line.slice(1) });
      targetLine += 1;
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      targetLine += 1;
    }
  }
  return added;
}

function reviewPatch({ patchText, manifest }) {
  const patchFiles = changedFilesFromPatch(patchText);
  const manifestFiles = [...new Set((manifest || []).map(item => item?.path).filter(Boolean))].sort();
  if (JSON.stringify(patchFiles) !== JSON.stringify(manifestFiles)) {
    throw new Error('changed-file manifest does not match patch');
  }

  const findings = [];
  try {
    validatePatchText(patchText);
  } catch (error) {
    if (!String(error.message).includes('protected frontend changes require separate approval')) throw error;
  }
  for (const file of patchFiles) {
    if (PROTECTED_FRONTEND_PATHS.some(pattern => pattern.test(file))) {
      findings.push({
        rule_id: 'protected-surface-change',
        severity: 'critical',
        file,
        line: null,
        message: 'Authentication, routing, access-control, or safety surface changed'
      });
    }
  }
  for (const added of addedLinesByFile(patchText)) {
    for (const rule of RULES) {
      if (rule.pattern.test(added.content)) {
        findings.push({
          rule_id: rule.id,
          severity: rule.severity,
          file: added.file,
          line: added.line,
          message: rule.message
        });
      }
    }
  }

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return {
    passed: counts.critical === 0 && counts.high === 0,
    counts,
    findings,
    reviewed_files: patchFiles
  };
}

function executeSecurityReview({ patchPath, manifestPath, outputPath }) {
  const patchBytes = fs.readFileSync(patchPath);
  const manifestBytes = fs.readFileSync(manifestPath);
  const patchText = patchBytes.toString('utf8');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const report = {
    ...reviewPatch({ patchText, manifest }),
    patch_sha256: crypto.createHash('sha256').update(patchBytes).digest('hex'),
    manifest_sha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
    scanner: 'bob-static-security-v1'
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) throw new Error('security report exceeds size limit');
  fs.writeFileSync(outputPath, serialized, { mode: 0o600 });
  return report;
}

function main() {
  const [patchPath, manifestPath, outputPath] = process.argv.slice(2);
  if (!patchPath || !manifestPath || !outputPath) throw new Error('patchPath, manifestPath, and outputPath are required');
  const report = executeSecurityReview({ patchPath, manifestPath, outputPath });
  process.stdout.write(`${JSON.stringify({ passed: report.passed, counts: report.counts })}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  RULES,
  addedLinesByFile,
  reviewPatch,
  executeSecurityReview
};