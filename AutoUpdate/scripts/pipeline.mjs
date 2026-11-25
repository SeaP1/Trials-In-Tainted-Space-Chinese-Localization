import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const GAME_ROOT = process.env.TITS_GAME_ROOT
  ? path.resolve(process.env.TITS_GAME_ROOT)
  : path.resolve(DIR, '..');
export const TRANSLATOR_ROOT = process.env.TITS_TRANSLATOR_ROOT
  ? path.resolve(process.env.TITS_TRANSLATOR_ROOT)
  : path.join(GAME_ROOT, 'translator');
export const APP = path.join(GAME_ROOT, 'resources', 'app');
export const EXTRACTED = path.join(TRANSLATOR_ROOT, 'extracted_json');
export const TRANSLATED = path.join(TRANSLATOR_ROOT, 'translated_json');
export const sha1 = text => crypto.createHash('sha1').update(text).digest('hex');
export const parseJs = source => parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
export function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(doc, null, 2) + '\n');
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    // Windows may reject rename-over-existing even on the same volume.
    if (error?.code !== 'EPERM' && error?.code !== 'EEXIST') throw error;
    fs.copyFileSync(temp, file);
    fs.unlinkSync(temp);
  }
}
export function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
}
export function jsonFiles(input) {
  return fs.statSync(input).isDirectory()
    ? fs.readdirSync(input).filter(n => n.endsWith('.json') && !n.startsWith('_')).sort().map(n => path.join(input, n))
    : [input];
}
export const enabled = row => row.shouldTranslate === true && row.shouldTranslated !== false;
export function manualTranslationStatus(translated, original = '') {
  const translatedCount = [...String(translated)].filter(ch => ch === '—').length;
  const originalCount = [...String(original)].filter(ch => ch === '—').length;
  const count = Math.max(0, translatedCount - originalCount);
  return count ? `manual_translated_${count}—` : 'manual_translated';
}
export function approvedTranslationStatus(row) {
  // Explicitly reviewed structural whitespace or an intentionally empty
  // fragment used when Chinese word order moves the visible text elsewhere.
  if (row.translationStatus === 'manual_blank') {
    return row.translationModel === 'Manual' && typeof row.translation === 'string' && row.translation.trim() === '';
  }
  if (row.translationStatus === 'ollama_translated' || row.translationStatus === 'manual' || row.translationStatus === 'manual_abnormal') return true;
  // Explicit manual-review marker for translations that deliberately add a
  // counted pair of Chinese quotation marks to preserve a source-wordplay cue.
  if (/^manual_translated_\d+“”$/.test(row.translationStatus ?? '')) return true;
  const currentStatus = manualTranslationStatus(row.translation, row.original);
  const legacyCount = [...String(row.translation)].filter(ch => ch === '—').length;
  const legacyStatus = legacyCount ? `manual_translated_${legacyCount}—` : 'manual_translated';
  return row.translationStatus === currentStatus || row.translationStatus === legacyStatus;
}
export function rowUnits(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row.unitId) continue;
    if (!grouped.has(row.unitId)) grouped.set(row.unitId, []);
    grouped.get(row.unitId).push(row);
  }
  const seen = new Set(), units = [];
  for (const row of rows) {
    if (!row.unitId) { units.push([row]); continue; }
    if (seen.has(row.unitId)) continue;
    seen.add(row.unitId);
    units.push(grouped.get(row.unitId));
  }
  return units;
}
export function sourceFor(doc) {
  if (path.basename(doc.file) !== doc.file || !/^(content_.*|main\.[\da-f]+)\.js$/i.test(doc.file)) throw Error('Invalid source filename');
  const source = fs.readFileSync(path.join(APP, doc.file), 'utf8');
  if (sha1(source) !== doc.sourceSha1) throw Error(`Source changed: ${doc.file}; extract again before translating/applying`);
  return source;
}

// Syntax is checked in addition to protecting placeholders before calling Ollama.
const visibleBracketLabels = new Set([
  '[Backers Only]',
  '[Completed]',
  '[Locked]',
  '[Uninstalled]',
  '[ No Subject ]',
  '[Extrapolated due to limited data]',
  '[Data courtesy of the Camarilla, all rights reserved.]',
  '[urgent]',
]);

export function protectedTokens(text) {
  const matches = text.match(/__E\d+__|<\/?[A-Za-z][^>]*>|&(?:[A-Za-z]+|#\d+|#x[\da-f]+);|(?<!\\)\[[^\[\]|]*\]/gi) || [];
  return matches.filter(token => {
    if (!token.startsWith('[')) return true;
    // These are literal player-facing labels styled with square brackets, not
    // parser placeholders. Chinese bracket labels and labels containing HTML
    // are protected by bracket counts/HTML checks instead of exact text.
    if (visibleBracketLabels.has(token)) return false;
    const inner = token.slice(1, -1);
    if (/[\u3400-\u9fff]/u.test(inner) || /<\/?[A-Za-z]/.test(inner)) return false;
    return true;
  });
}
export function structureIssues(original, translated) {
  const issues = [];
  const newlineWhitespace = text => [...text.matchAll(/\n([ \t]*)/g)].map(match => match[1]);
  const tokens = text => protectedTokens(text);
  // Text in these attributes is player-facing.  Preserve the surrounding tag,
  // attribute names, quoting, IDs, classes and event handlers, while allowing
  // only the visible attribute value itself to be localized.
  const normalizeVisibleHtmlAttributes = token => token.replace(
    /(\s(?:title|aria-label|alt|placeholder)=)(["'])(.*?)\2/gi,
    (_match, prefix, quote, value) => {
      const expressions = [...value.matchAll(/__E\d+__/g)].map(match => match[0]).join('');
      return `${prefix}${quote}__VISIBLE_TEXT__${expressions}${quote}`;
    },
  );
  const ordered = text => tokens(text)
    .filter(token => token.startsWith('<') || token.startsWith('__E'))
    .map(token => token.startsWith('<') ? normalizeVisibleHtmlAttributes(token) : token);
  const bag = text => tokens(text).filter(token => !token.startsWith('<') && !token.startsWith('__E')).sort();
  if (JSON.stringify(ordered(original)) !== JSON.stringify(ordered(translated))) issues.push('HTML/expression token order changed');
  if (JSON.stringify(bag(original)) !== JSON.stringify(bag(translated))) issues.push('entity/game placeholder count changed');
  if (JSON.stringify(newlineWhitespace(original)) !== JSON.stringify(newlineWhitespace(translated))) issues.push('whitespace after newline changed');
  for (const ch of ['[', ']', '|', '\n']) {
    if (original.split(ch).length !== translated.split(ch).length) issues.push(`count changed: ${JSON.stringify(ch)}`);
  }
  // Indentation following a conditional header is validated separately by
  // newlineWhitespace. It is formatting, not part of the parser key.
  const heads = text => [...text.matchAll(/\[([^\[\]|]+)\|/g)].map(m => m[1].trim());
  if (JSON.stringify(heads(original)) !== JSON.stringify(heads(translated))) issues.push('conditional parser headers changed');
  return issues;
}
