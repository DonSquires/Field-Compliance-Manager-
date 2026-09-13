const fs = require('node:fs');
const path = require('node:path');

const sourceRoot = path.join(process.cwd(), 'apps', 'web', 'src');
const sourceFiles = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filePath);
    else if (filePath.endsWith('.tsx')) sourceFiles.push(filePath);
  }
}

function cssClasses(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const source = fs.readFileSync(filePath, 'utf8');
  return new Set([...source.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((match) => match[1]));
}

function allStylesheets(directory) {
  const styles = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) styles.push(...allStylesheets(filePath));
    else if (filePath.endsWith('.css')) styles.push(filePath);
  }
  return styles;
}

function importedStyles(source, filePath) {
  return [...source.matchAll(/import\s+["'](\.\/[^"']+\.css)["']/g)].map((match) => path.resolve(path.dirname(filePath), match[1]));
}

function staticClasses(source) {
  const classes = [];
  for (const match of source.matchAll(/className\s*=\s*["']([^"']+)["']/g)) {
    for (const token of match[1].split(/\s+/)) {
      if (token && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(token)) classes.push(token);
    }
  }
  return new Set(classes);
}

walk(sourceRoot);
const globalClasses = new Set(allStylesheets(sourceRoot).flatMap((style) => [...cssClasses(style)]));
const missing = [];
for (const filePath of sourceFiles) {
  const source = fs.readFileSync(filePath, 'utf8');
  const styles = importedStyles(source, filePath);
  if (!styles.length) continue;
  for (const className of staticClasses(source)) {
    if (!globalClasses.has(className)) missing.push(`${path.relative(process.cwd(), filePath)}: ${className}`);
  }
}

if (missing.length) {
  console.error('Static CSS contract mismatches detected:');
  for (const item of missing.sort()) console.error(`  ${item}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${sourceFiles.length} TSX files with local CSS imports: all static class names have matching selectors.`);
}
