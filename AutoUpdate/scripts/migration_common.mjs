import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');
export const moduleKey = name => path.basename(name)
  .replace(/\.json$/i, '')
  .replace(/\.js$/i, '')
  .replace(/\.[a-f0-9]{8,}$/i, '');
export const jsonNames = dir => fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(name => /^(?:content_.*|main\.[a-f0-9]+)\.js\.json$/i.test(name)).sort()
  : [];
export const jsNames = dir => fs.readdirSync(dir)
  .filter(name => /^(?:content_.*|main\.[a-f0-9]+)\.js$/i.test(name)).sort();

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (fs.existsSync(file)) fs.rmSync(file);
  fs.renameSync(temp, file);
}

export function directoryFingerprint(dir) {
  return sha1(jsonNames(dir).map(name => {
    const body = fs.readFileSync(path.join(dir, name));
    return `${name}\0${sha1(body)}`;
  }).join('\n'));
}

export function assertSourceRanges(rows, source, label) {
  const ranges = new Set();
  for (const row of rows) {
    if (!Number.isInteger(row.start) || !Number.isInteger(row.end) || row.start < 0 || row.end <= row.start || row.end > source.length) {
      throw new Error(`${label}: invalid range for ${row.id}`);
    }
    if (source.slice(row.start, row.end) !== row.raw) throw new Error(`${label}: raw source mismatch for ${row.id}`);
    const range = `${row.start}:${row.end}`;
    if (ranges.has(range)) throw new Error(`${label}: duplicate range ${range}`);
    ranges.add(range);
  }
}

export function summarizeRows(rows) {
  const byCategory = {};
  for (const row of rows) byCategory[row.category] = (byCategory[row.category] || 0) + 1;
  return {
    total: rows.length,
    shouldTranslate: rows.filter(row => row.shouldTranslate === true).length,
    needsReview: rows.filter(row => row.needsReview === true).length,
    byCategory,
  };
}
