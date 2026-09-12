const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(process.argv[2] ?? 'Build-Plan/sample data');
const quarantineExtensions = new Set(['.apk', '.bin', '.crdownload', '.db', '.download', '.exe', '.iqy', '.lnk', '.mdb', '.url']);
const sourceExtensions = new Set(['.cjs', '.css', '.h', '.js', '.mjs', '.sh', '.sql', '.ts', '.tsx', '.yaml', '.yml']);
const quarantineNames = [/^~\$/, /diagnostic/i, /personal vault/i];
const ignoredDirectories = new Set(['.git', '.hg', '.svn', 'dist', 'node_modules', 'target']);

function classify(fileName) {
  const lower = fileName.toLowerCase();
  const extension = path.extname(lower);
  if (fileName === 'HPLJM278-M281_Fax_Port') return { ingestion_class: 'exclude', quarantine_reason: 'Empty placeholder listed as excluded in the sample-data capability matrix' };
  if (quarantineExtensions.has(extension) || quarantineNames.some((pattern) => pattern.test(fileName))) return { ingestion_class: 'quarantine', quarantine_reason: 'Executable, partial download, shortcut, database, or diagnostic artifact' };
  if (sourceExtensions.has(extension)) return { ingestion_class: 'quarantine', quarantine_reason: 'Source code, repository, configuration, or engineering artifact' };
  if (['.7z', '.rar', '.tar', '.zip'].includes(extension)) return { ingestion_class: 'archive_review', quarantine_reason: null };
  if (['.avi', '.heic', '.jpeg', '.jpg', '.mp4', '.png'].includes(extension)) return { ingestion_class: 'media', quarantine_reason: null };
  if (['.csv', '.json', '.xls', '.xlsm', '.xlsx', '.xml'].includes(extension)) return { ingestion_class: 'structured_data', quarantine_reason: null };
  if (['.doc', '.docx', '.eml', '.htm', '.html', '.md', '.msg', '.pdf', '.ppt', '.pptx', '.txt'].includes(extension)) return { ingestion_class: 'document', quarantine_reason: null };
  return { ingestion_class: 'unclassified', quarantine_reason: 'No registered parser' };
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function walk(directory) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) files.push(...await walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

async function main() {
  if (!fs.existsSync(root)) throw new Error(`Sample-data directory not found: ${root}`);
  const files = await walk(root);
  const manifest = [];
  for (const filePath of files) {
    const stat = await fs.promises.stat(filePath);
    const relativePath = path.relative(process.cwd(), filePath).replaceAll(path.sep, '/');
    const classification = classify(path.basename(filePath));
    manifest.push({
      path: relativePath,
      file_name: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
      sha256: await hashFile(filePath),
      ...classification,
    });
  }
  process.stdout.write(`${JSON.stringify({ generated_at: new Date().toISOString(), root: path.relative(process.cwd(), root).replaceAll(path.sep, '/'), file_count: manifest.length, total_bytes: manifest.reduce((sum, item) => sum + item.bytes, 0), files: manifest }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});