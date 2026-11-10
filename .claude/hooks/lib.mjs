import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hooksDir = path.dirname(fileURLToPath(import.meta.url));

export function loadPolicy(file = path.join(hooksDir, 'policy.json')) {
  const policy = JSON.parse(readFileSync(file, 'utf8'));
  const compile = (entry) => ({
    ...entry,
    regex: new RegExp(entry.pattern),
    allowRegex: entry.allowPattern ? new RegExp(entry.allowPattern) : null,
  });
  return {
    protectedPaths: (policy.protectedPaths || []).map(compile),
    opaqueCommandPatterns: (policy.opaqueCommandPatterns || []).map(compile),
    protectedCommandTargets: (policy.protectedCommandTargets || []).map(compile),
    releaseIdentity: policy.releaseIdentity || null,
    protectedBranches: policy.protectedBranches || [],
    postEditChecks: (policy.postEditChecks || []).map(compile),
  };
}

export function projectDirFrom(input = {}) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

function toNativePath(value) {
  let p = String(value || '').trim().replace(/^["']|["']$/g, '');
  // Git Bash style /c/Users/... on Windows.
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  if (process.platform === 'win32' && msys) p = `${msys[1]}:/${msys[2]}`;
  return p;
}

// Returns the path relative to the project root with forward slashes, or null when it is outside it.
export function repoRelative(filePath, projectDir, baseDir = projectDir) {
  if (!filePath) return null;
  const native = toNativePath(filePath);
  const absolute = path.resolve(toNativePath(baseDir), native);
  const relative = path.relative(path.resolve(toNativePath(projectDir)), absolute).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) return null;
  return relative;
}

export function matchProtectedPath(relativePath, policy) {
  if (relativePath == null) return null;
  return policy.protectedPaths.find((rule) => rule.regex.test(relativePath) && !(rule.allowRegex && rule.allowRegex.test(relativePath))) || null;
}

// Repository-anchored rules (pattern starts with ^) apply inside the project; unanchored rules,
// such as secret env files, apply wherever the file lives.
export function protectedRuleFor(filePath, policy, projectDir, baseDir = projectDir) {
  if (!filePath) return null;
  const relative = repoRelative(filePath, projectDir, baseDir);
  if (relative != null) return matchProtectedPath(relative, policy);
  const absolute = path.resolve(toNativePath(baseDir), toNativePath(filePath)).replace(/\\/g, '/');
  return policy.protectedPaths.find((rule) => !rule.pattern.startsWith('^') && rule.regex.test(absolute)
    && !(rule.allowRegex && rule.allowRegex.test(absolute))) || null;
}
