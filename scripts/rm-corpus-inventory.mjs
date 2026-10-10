#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DOCUMENT_EXTENSIONS = new Set([
  '.doc', '.docx', '.eml', '.html', '.md', '.msg', '.pdf', '.ppt', '.pptx', '.rtf', '.txt',
]);
const STRUCTURED_EXTENSIONS = new Set(['.csv', '.json', '.xls', '.xlsm', '.xlsx', '.xml']);
const IMAGE_EXTENSIONS = new Set(['.gif', '.heic', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff']);
const MEDIA_EXTENSIONS = new Set(['.avi', '.mov', '.mp3', '.mp4', '.wav']);
const ARCHIVE_EXTENSIONS = new Set(['.7z', '.rar', '.tar', '.zip']);
const PROPRIETARY_MEDIA_EXTENSIONS = new Set(['.asf', '.dav', '.idx', '.nmea']);
const QUARANTINE_EXTENSIONS = new Set([
  '.apk', '.bin', '.crdownload', '.css', '.db', '.dll', '.download', '.exe', '.iqy', '.js',
  '.kss', '.lnk', '.mdb', '.msi', '.ps1', '.sql', '.ts', '.url',
]);
const MAX_HASH_BYTES = 50 * 1024 * 1024;

const DOMAIN_RULES = [
  { pattern: /^(admin - [^\\/]+|staff details)(?:[\\/]|$)/i, domain: 'people', sensitivity: 'restricted' },
  { pattern: /^(investigations|trespass notices|security alerts)(?:[\\/]|$)/i, domain: 'investigations', sensitivity: 'restricted' },
  { pattern: /^(invoice spreadsheets)(?:[\\/]|$)/i, domain: 'finance', sensitivity: 'restricted' },
  { pattern: /^(quotes)(?:[\\/]|$)/i, domain: 'proposals', sensitivity: 'tenant_sensitive' },
  { pattern: /^(health and safety)(?:[\\/]|$)/i, domain: 'health_safety', sensitivity: 'tenant_sensitive' },
  { pattern: /^(branding|flyers - all co)(?:[\\/]|$)/i, domain: 'branding', sensitivity: 'internal_non_sensitive' },
  { pattern: /^(photos|patrol log entries|warning letter|warning letters|found property reports)(?:[\\/]|$)/i, domain: 'field_evidence', sensitivity: 'tenant_sensitive' },
  { pattern: /^(archive remsec|admin archive|outlook files)(?:[\\/]|$)/i, domain: 'archive', sensitivity: 'restricted' },
];

function normalizeRelative(relativePath) {
  return relativePath.split(path.sep).join('/');
}

export function classifyDomain(relativePath) {
  const normalized = normalizeRelative(relativePath);
  const matched = DOMAIN_RULES.find((rule) => rule.pattern.test(normalized));
  if (matched) return { domain: matched.domain, sensitivity: matched.sensitivity };
  return { domain: 'client_operations', sensitivity: 'tenant_sensitive' };
}

export function classifyFile(relativePath, bytes = 0) {
  const fileName = path.basename(relativePath);
  const extension = path.extname(fileName).toLowerCase();
  const lowerName = fileName.toLowerCase();
  const domain = classifyDomain(relativePath);

  if (/^~\$/.test(fileName) || lowerName === 'thumbs.db' || bytes === 0) {
    return { ...domain, ingestion_class: 'exclude', capability: 'exclude', reason: 'Temporary, empty, or operating-system artifact' };
  }
  if (QUARANTINE_EXTENSIONS.has(extension)) {
    return { ...domain, ingestion_class: 'quarantine', capability: 'exclude', reason: 'Executable, partial download, shortcut, database, source, or diagnostic artifact' };
  }
  if (PROPRIETARY_MEDIA_EXTENSIONS.has(extension)) {
    return { ...domain, ingestion_class: 'quarantine', capability: 'gap', reason: 'Proprietary recorder/media format requires a governed converter before intake' };
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return { ...domain, ingestion_class: 'archive_review', capability: 'partial', reason: 'Archive requires safe listing, expansion limits, and per-entry classification' };
  }
  if (STRUCTURED_EXTENSIONS.has(extension)) {
    return { ...domain, ingestion_class: 'structured_data', capability: 'partial', reason: 'Preview and human-approved field mapping required before promotion' };
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return { ...domain, ingestion_class: 'document', capability: 'partial', reason: 'Document registration is supported; extraction and promotion require review' };
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return { ...domain, ingestion_class: 'image', capability: 'supported', reason: 'Evidence/brand storage is supported; consequential classification requires review' };
  }
  if (MEDIA_EXTENSIONS.has(extension)) {
    return { ...domain, ingestion_class: 'media', capability: 'partial', reason: 'Media evidence is supported, but bulk ingestion requires dedupe and retention controls' };
  }
  return { ...domain, ingestion_class: 'unclassified', capability: 'gap', reason: 'No registered parser or governed destination' };
}

function shouldHash(item, hashMode) {
  if (hashMode === 'none' || item.bytes > MAX_HASH_BYTES) return false;
  if (hashMode === 'all') return item.ingestion_class !== 'exclude' && item.ingestion_class !== 'quarantine';
  return ['document', 'structured_data', 'archive_review'].includes(item.ingestion_class);
}

function shouldListCandidate(item) {
  return !['exclude', 'quarantine', 'unclassified'].includes(item.ingestion_class);
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function walk(root) {
  const pending = [root];
  const files = [];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      files.push({ error: error instanceof Error ? error.message : String(error), path: directory, kind: 'directory_error' });
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push({ path: absolute, kind: 'file' });
    }
  }
  return files;
}

function increment(map, key, bytes) {
  const current = map.get(key) ?? { count: 0, bytes: 0 };
  current.count += 1;
  current.bytes += bytes;
  map.set(key, current);
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export async function buildInventory({ root, candidateOut, summaryOut, hashMode = 'candidates' }) {
  const resolvedRoot = path.resolve(root);
  const discovered = await walk(resolvedRoot);
  const byClass = new Map();
  const byDomain = new Map();
  const byExtension = new Map();
  const errors = [];
  let fileCount = 0;
  let totalBytes = 0;
  let candidateCount = 0;
  let hashedCount = 0;

  await fs.promises.mkdir(path.dirname(candidateOut), { recursive: true });
  const candidateStream = fs.createWriteStream(candidateOut, { encoding: 'utf8' });

  for (const entry of discovered) {
    if (entry.kind !== 'file') {
      errors.push({ path: entry.path, error: entry.error });
      continue;
    }
    try {
      const stat = await fs.promises.stat(entry.path);
      const relativePath = normalizeRelative(path.relative(resolvedRoot, entry.path));
      const classification = classifyFile(relativePath, stat.size);
      const item = {
        relative_path: relativePath,
        file_name: path.basename(entry.path),
        extension: path.extname(entry.path).toLowerCase(),
        bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        ...classification,
      };
      if (shouldHash(item, hashMode)) {
        try {
          item.sha256 = await hashFile(entry.path);
          hashedCount += 1;
        } catch (error) {
          item.hash_error = error instanceof Error ? error.message : String(error);
        }
      }
      fileCount += 1;
      totalBytes += stat.size;
      increment(byClass, item.ingestion_class, stat.size);
      increment(byDomain, item.domain, stat.size);
      increment(byExtension, item.extension || '[none]', stat.size);
      if (shouldListCandidate(item)) {
        candidateStream.write(`${JSON.stringify(item)}\n`);
        candidateCount += 1;
      }
    } catch (error) {
      errors.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  await new Promise((resolve, reject) => {
    candidateStream.on('error', reject);
    candidateStream.end(resolve);
  });

  const summary = {
    generated_at: new Date().toISOString(),
    root: resolvedRoot,
    file_count: fileCount,
    total_bytes: totalBytes,
    candidate_count: candidateCount,
    hashed_count: hashedCount,
    hash_mode: hashMode,
    max_hash_bytes: MAX_HASH_BYTES,
    by_ingestion_class: mapToObject(byClass),
    by_domain: mapToObject(byDomain),
    by_extension: mapToObject(byExtension),
    errors,
    candidate_manifest: path.resolve(candidateOut),
  };
  await fs.promises.writeFile(summaryOut, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const root = option(args, '--root', process.env.RM_CORPUS_ROOT);
  if (!root) throw new Error('--root or RM_CORPUS_ROOT is required');
  const summaryOut = path.resolve(option(args, '--summary-out', 'rm-corpus-inventory-summary.json'));
  const candidateOut = path.resolve(option(args, '--candidate-out', 'rm-corpus-candidates.jsonl'));
  const hashMode = option(args, '--hash', 'candidates');
  if (!['none', 'candidates', 'all'].includes(hashMode)) throw new Error('--hash must be none, candidates, or all');
  const summary = await buildInventory({ root, candidateOut, summaryOut, hashMode });
  process.stdout.write(`${JSON.stringify({
    summary_out: summaryOut,
    candidate_out: candidateOut,
    file_count: summary.file_count,
    candidate_count: summary.candidate_count,
    hashed_count: summary.hashed_count,
    error_count: summary.errors.length,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
