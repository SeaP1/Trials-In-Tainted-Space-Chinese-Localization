import fs from 'node:fs';
import path from 'node:path';
import { assertSourceRanges, jsonNames, moduleKey, readJson, writeJson } from './migration_common.mjs';

const argv = process.argv.slice(2);
const arg = name => argv[argv.indexOf(name) + 1];
const newRoot = path.resolve(arg('--new-root'));
const baselineDir = path.resolve(arg('--baseline-dir'));
const translatorRoot = path.join(newRoot, 'translator');
const extractedDir = path.join(translatorRoot, 'extracted_json');
const translatedDir = path.join(translatorRoot, 'translated_json');
const extractedNames = jsonNames(extractedDir);
const translatedNames = jsonNames(translatedDir);
if (JSON.stringify(extractedNames) !== JSON.stringify(translatedNames)) throw new Error('Extracted/translated file sets differ');

const protectedFields = ['id', 'file', 'original', 'start', 'end', 'line', 'raw', 'unitId', 'joinAfter'];
const classificationFields = ['category', 'shouldTranslate', 'shouldTranslated', 'needsReview', 'classificationReason', 'exclusionReason', 'reviewNote'];
const protectedFieldSet = new Set(protectedFields);
const oldByModule = new Map(jsonNames(baselineDir).map(name => [moduleKey(name), readJson(path.join(baselineDir, name))]));
const files = [];
let totalRows = 0;
let inheritedRows = 0;
let newRows = 0;
let inheritedTranslations = 0;
let stateOverrides = 0;
let synchronizedStateFields = 0;
let pendingTrue = 0;

for (const name of extractedNames) {
  const extracted = readJson(path.join(extractedDir, name));
  const translated = readJson(path.join(translatedDir, name));
  const oldDoc = oldByModule.get(moduleKey(name));
  const oldById = new Map((oldDoc?.rows || []).map(row => [row.id, row]));
  if (extracted.rows.length !== translated.rows.length) throw new Error(`${name}: row count differs`);
  const source = fs.readFileSync(path.join(newRoot, 'resources', 'app', name.slice(0, -5)), 'utf8');
  assertSourceRanges(translated.rows, source, name);
  for (let i = 0; i < extracted.rows.length; i += 1) {
    const left = extracted.rows[i], right = translated.rows[i];
    for (const field of protectedFields) {
      if (JSON.stringify(left[field] ?? null) !== JSON.stringify(right[field] ?? null)) {
        throw new Error(`${name}:${i}: source field changed: ${field}`);
      }
    }
    for (const field of classificationFields) {
      if (JSON.stringify(left[field] ?? null) !== JSON.stringify(right[field] ?? null)) {
        throw new Error(`${name}:${i}: extracted classification state differs: ${field}`);
      }
      if (Object.hasOwn(right, field)) synchronizedStateFields += 1;
    }
    if (right.migrationMatch) {
      inheritedRows += 1;
      if (typeof right.translation === 'string' && right.translation.trim()) inheritedTranslations += 1;
      const oldRow = oldById.get(right.previousId);
      if (!oldRow) throw new Error(`${name}:${i}: inherited source row was not found`);
      for (const [field, value] of Object.entries(oldRow)) {
        if (protectedFieldSet.has(field)) continue;
        if (JSON.stringify(value) !== JSON.stringify(right[field])) throw new Error(`${name}:${i}: inherited field changed: ${field}`);
      }
      if (Boolean(oldRow.shouldTranslate) !== Boolean(right.shouldTranslate)) stateOverrides += 1;
    }
    else {
      newRows += 1;
      if (right.translation !== '') throw new Error(`${name}:${i}: new/unmatched row unexpectedly has a translation`);
    }
    if (right.shouldTranslate === true && !(typeof right.translation === 'string' && right.translation.trim())) pendingTrue += 1;
  }
  totalRows += translated.rows.length;
  files.push({ file: name, rows: translated.rows.length, inherited: translated.rows.filter(row => row.migrationMatch).length });
}

const report = { verifiedAt: new Date().toISOString(), allChecksPassed: true, files: files.length, totalRows, inheritedRows, inheritedTranslations, newRows, stateOverrides, synchronizedStateFields, pendingTrue, details: files };
writeJson(path.join(translatorRoot, 'reports', 'verification.json'), report);
console.log(JSON.stringify(report, null, 2));
