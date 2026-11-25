import fs from 'node:fs';
import path from 'node:path';
import {
  assertSourceRanges,
  jsonNames,
  moduleKey,
  readJson,
  sha1,
  summarizeRows,
  writeJson,
} from './migration_common.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const oldRoot = path.resolve(arg('--old-root'));
const newRoot = path.resolve(arg('--new-root'));
const baselineDir = path.resolve(arg('--baseline-dir'));
const translatorRoot = path.join(newRoot, 'translator');
const extractedDir = path.join(translatorRoot, 'extracted_json');
const outputDir = path.join(translatorRoot, 'translated_json');
const reportsDir = path.join(translatorRoot, 'reports');
const overwrite = argv.includes('--overwrite');
const manualOverrideArgument = arg('--manual-overrides');
const manualOverridePath = manualOverrideArgument ? path.resolve(manualOverrideArgument) : '';
const versionOf = root => readJson(path.join(root, 'resources', 'app', 'package.json')).version;
const oldVersion = versionOf(oldRoot), newVersion = versionOf(newRoot);
const overrideDocument = fs.existsSync(manualOverridePath) ? readJson(manualOverridePath) : null;
const overrideProfiles = overrideDocument
  ? (Array.isArray(overrideDocument.profiles) ? overrideDocument.profiles : [overrideDocument])
  : [];
const matchingOverrideProfiles = overrideProfiles.filter(profile =>
  profile.oldVersion === oldVersion && profile.newVersion === newVersion
);
if (matchingOverrideProfiles.length > 1) {
  throw new Error(`Duplicate manual migration profiles for ${oldVersion} -> ${newVersion}`);
}
const selectedOverrideProfile = matchingOverrideProfiles[0] || null;
const manualOverrides = selectedOverrideProfile?.pairs || [];
if (!Array.isArray(manualOverrides)) {
  throw new Error(`Manual migration profile pairs must be an array: ${oldVersion} -> ${newVersion}`);
}
console.log(selectedOverrideProfile
  ? `Manual migration profile selected: ${oldVersion} -> ${newVersion} (${manualOverrides.length} pairs)`
  : `No manual migration profile for ${oldVersion} -> ${newVersion}; strict matching only`);

if (!fs.existsSync(oldRoot) || !fs.existsSync(newRoot) || !fs.existsSync(baselineDir)) throw new Error('Missing migration input directory');
if (fs.existsSync(outputDir) && jsonNames(outputDir).length && !overwrite) {
  throw new Error('translated_json already contains files; pass --resume only for a deliberate regeneration');
}

const sourceFields = new Set(['id', 'file', 'original', 'start', 'end', 'line', 'raw', 'unitId', 'joinAfter']);
const classificationFields = [
  'category',
  'shouldTranslate',
  'shouldTranslated',
  'needsReview',
  'classificationReason',
  'exclusionReason',
  'reviewNote',
];
const oldByModule = new Map(jsonNames(baselineDir).map(name => [moduleKey(name), name]));
const files = [];
const inheritedAudit = [];
const ambiguities = [];
const oldUnmatched = [];
const newRecords = [];
const seenOldModules = new Set();
let manualOverridesApplied = 0;

function rowsAsUnits(rows) {
  const grouped = new Map();
  rows.forEach((row, index) => {
    const key = row.unitId ? `unit:${row.unitId}` : `row:${index}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ row, index });
  });
  return [...grouped.values()].sort((a, b) => a[0].index - b[0].index);
}

function structuralRow(row) {
  return {
    original: row.original,
    raw: row.raw,
    context: row.context ?? null,
    joinAfter: row.joinAfter ?? null,
  };
}

function unitSignature(unit) {
  return JSON.stringify(unit.map(({ row }) => structuralRow(row)));
}

function originalUnitSignature(unit) {
  return JSON.stringify(unit.map(({ row }) => row.original));
}

function transferStateSignature(unit) {
  return JSON.stringify(unit.map(({ row }) => Object.fromEntries(
    Object.entries(row).filter(([field]) => !sourceFields.has(field) && !['previousId', 'migrationMatch'].includes(field)),
  )));
}

function sourceContext(source, unit, radius = 256) {
  const start = unit[0].row.start;
  const end = unit.at(-1).row.end;
  return JSON.stringify({
    before: source.slice(Math.max(0, start - radius), start),
    after: source.slice(end, Math.min(source.length, end + radius)),
  });
}

function neighborhood(units, index) {
  return JSON.stringify([
    index > 1 ? unitSignature(units[index - 2]) : null,
    index > 0 ? unitSignature(units[index - 1]) : null,
    index + 1 < units.length ? unitSignature(units[index + 1]) : null,
    index + 2 < units.length ? unitSignature(units[index + 2]) : null,
  ]);
}

function groupIndices(units) {
  const groups = new Map();
  units.forEach((unit, index) => {
    const signature = unitSignature(unit);
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(index);
  });
  return groups;
}

function inheritRow(fresh, old, migrationMatch) {
  const result = { ...fresh };
  for (const [field, value] of Object.entries(old)) {
    if (!sourceFields.has(field)) result[field] = value;
  }
  result.previousId = old.id;
  result.migrationMatch = migrationMatch;
  return result;
}

function syncClassification(fresh, translated) {
  const result = { ...fresh };
  for (const field of classificationFields) {
    if (Object.hasOwn(translated, field)) result[field] = translated[field];
    else delete result[field];
  }
  return result;
}

function matchUnits(oldUnits, newUnits, oldSource, newSource, module) {
  const pairs = [];
  const oldUsed = new Set();
  const newUsed = new Set();
  const oldGroups = groupIndices(oldUnits);
  const newGroups = groupIndices(newUnits);
  const oldSourceContexts = oldUnits.map(unit => sourceContext(oldSource, unit));
  const newSourceContexts = newUnits.map(unit => sourceContext(newSource, unit));
  const oldNeighborhoods = oldUnits.map((_, index) => neighborhood(oldUnits, index));
  const newNeighborhoods = newUnits.map((_, index) => neighborhood(newUnits, index));

  for (const [signature, oldIndices] of oldGroups) {
    const newIndices = newGroups.get(signature) || [];
    if (oldIndices.length === 1 && newIndices.length === 1) {
      pairs.push({ oldIndex: oldIndices[0], newIndex: newIndices[0], reason: 'exact_unique_structure' });
      oldUsed.add(oldIndices[0]);
      newUsed.add(newIndices[0]);
    }
  }

  for (const [signature, oldIndices] of oldGroups) {
    const newIndices = newGroups.get(signature) || [];
    const remainingOld = oldIndices.filter(index => !oldUsed.has(index));
    const remainingNew = newIndices.filter(index => !newUsed.has(index));
    if (!remainingOld.length || !remainingNew.length) continue;
    const matchUniqueKey = (oldPool, newPool, oldKeys, newKeys, reason) => {
      const oldByKey = new Map(), newByKey = new Map();
      for (const index of oldPool) {
        const key = oldKeys[index];
        if (!oldByKey.has(key)) oldByKey.set(key, []);
        oldByKey.get(key).push(index);
      }
      for (const index of newPool) {
        const key = newKeys[index];
        if (!newByKey.has(key)) newByKey.set(key, []);
        newByKey.get(key).push(index);
      }
      for (const [key, oldMatches] of oldByKey) {
        const newMatches = newByKey.get(key) || [];
        if (oldMatches.length !== 1 || newMatches.length !== 1) continue;
        const oldIndex = oldMatches[0], newIndex = newMatches[0];
        if (oldUsed.has(oldIndex) || newUsed.has(newIndex)) continue;
        pairs.push({ oldIndex, newIndex, reason });
        oldUsed.add(oldIndex);
        newUsed.add(newIndex);
      }
    };
    matchUniqueKey(remainingOld, remainingNew, oldSourceContexts, newSourceContexts, 'exact_source_context');
    matchUniqueKey(
      remainingOld.filter(index => !oldUsed.has(index)),
      remainingNew.filter(index => !newUsed.has(index)),
      oldNeighborhoods,
      newNeighborhoods,
      'exact_neighbor_context',
    );
  }

  // A second, still exact, pass handles refactors that changed quoting, AST
  // context, or concatenation metadata while leaving every English literal in
  // the complete translation unit byte-for-byte identical. Unique units are
  // unambiguous. Repeated units are paired only when counts agree and every
  // old unit carries exactly the same translation/classification state.
  const oldOriginalGroups = new Map(), newOriginalGroups = new Map();
  oldUnits.forEach((unit, index) => {
    if (oldUsed.has(index)) return;
    const signature = originalUnitSignature(unit);
    if (!oldOriginalGroups.has(signature)) oldOriginalGroups.set(signature, []);
    oldOriginalGroups.get(signature).push(index);
  });
  newUnits.forEach((unit, index) => {
    if (newUsed.has(index)) return;
    const signature = originalUnitSignature(unit);
    if (!newOriginalGroups.has(signature)) newOriginalGroups.set(signature, []);
    newOriginalGroups.get(signature).push(index);
  });
  for (const [signature, oldIndices] of oldOriginalGroups) {
    const newIndices = newOriginalGroups.get(signature) || [];
    if (oldIndices.length === 1 && newIndices.length === 1) {
      pairs.push({ oldIndex: oldIndices[0], newIndex: newIndices[0], reason: 'exact_unique_original_unit' });
      oldUsed.add(oldIndices[0]);
      newUsed.add(newIndices[0]);
      continue;
    }
    if (!oldIndices.length || oldIndices.length !== newIndices.length) continue;
    if (new Set(oldIndices.map(index => transferStateSignature(oldUnits[index]))).size !== 1) continue;
    for (let i = 0; i < oldIndices.length; i += 1) {
      pairs.push({ oldIndex: oldIndices[i], newIndex: newIndices[i], reason: 'exact_original_unit_uniform_state' });
      oldUsed.add(oldIndices[i]);
      newUsed.add(newIndices[i]);
    }
  }

  const oldRowUsed = new Set();
  const newRowUsed = new Set();
  for (const pair of pairs) {
    for (const entry of oldUnits[pair.oldIndex]) oldRowUsed.add(entry.index);
    for (const entry of newUnits[pair.newIndex]) newRowUsed.add(entry.index);
  }

  // Recover exact rows inside larger units as well. The apply pipeline already
  // refuses to publish a unit until every fragment is approved, so preserving
  // a confirmed old fragment here cannot produce a half-translated JS output.
  const oldRowGroups = new Map(), newRowGroups = new Map();
  for (const unit of oldUnits) for (const entry of unit) {
    if (oldRowUsed.has(entry.index)) continue;
    const signature = JSON.stringify(structuralRow(entry.row));
    if (!oldRowGroups.has(signature)) oldRowGroups.set(signature, []);
    oldRowGroups.get(signature).push(entry);
  }
  for (const unit of newUnits) for (const entry of unit) {
    if (newRowUsed.has(entry.index)) continue;
    const signature = JSON.stringify(structuralRow(entry.row));
    if (!newRowGroups.has(signature)) newRowGroups.set(signature, []);
    newRowGroups.get(signature).push(entry);
  }
  const candidateByNewRow = new Map(), candidateReasonByNewRow = new Map();
  for (const [signature, oldEntries] of oldRowGroups) {
    const newEntries = newRowGroups.get(signature) || [];
    if (oldEntries.length === 1 && newEntries.length === 1) {
      candidateByNewRow.set(newEntries[0].index, oldEntries[0]);
      candidateReasonByNewRow.set(newEntries[0].index, 'exact_unique_structural_row');
      continue;
    }
    if (!oldEntries.length || oldEntries.length !== newEntries.length) continue;
    if (new Set(oldEntries.map(entry => transferStateSignature([entry]))).size !== 1) continue;
    for (let i = 0; i < oldEntries.length; i += 1) {
      candidateByNewRow.set(newEntries[i].index, oldEntries[i]);
      candidateReasonByNewRow.set(newEntries[i].index, 'exact_structural_row_uniform_state');
    }
  }

  // Use already-confirmed unit matches as monotonic anchors. Within each exact
  // pair of anchor boundaries, repeated structural rows can be paired by order
  // only when their counts are equal. This is a conservative exact sequence
  // alignment, not fuzzy matching.
  const rawAnchors = [];
  for (const pair of pairs) {
    const oldUnit = oldUnits[pair.oldIndex], newUnit = newUnits[pair.newIndex];
    for (let i = 0; i < oldUnit.length; i += 1) rawAnchors.push({ oldIndex: oldUnit[i].index, newIndex: newUnit[i].index });
  }
  rawAnchors.sort((a, b) => a.oldIndex - b.oldIndex || a.newIndex - b.newIndex);
  const tails = [], tailsAt = [], previous = new Array(rawAnchors.length).fill(-1);
  for (let i = 0; i < rawAnchors.length; i += 1) {
    const value = rawAnchors[i].newIndex;
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tails[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = value;
    previous[i] = lo ? tailsAt[lo - 1] : -1;
    tailsAt[lo] = i;
  }
  const anchors = [];
  for (let i = tailsAt[tails.length - 1] ?? -1; i >= 0; i = previous[i]) anchors.push(rawAnchors[i]);
  anchors.reverse();
  const oldRowCount = oldUnits.flat().length, newRowCount = newUnits.flat().length;
  anchors.unshift({ oldIndex: -1, newIndex: -1 });
  anchors.push({ oldIndex: oldRowCount, newIndex: newRowCount });
  const intervalFor = (index, field) => {
    let lo = 0, hi = anchors.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (anchors[mid][field] < index) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const candidateOldRows = new Set([...candidateByNewRow.values()].map(entry => entry.index));
  const oldGapGroups = new Map(), newGapGroups = new Map();
  for (const unit of oldUnits) for (const entry of unit) {
    if (oldRowUsed.has(entry.index) || candidateOldRows.has(entry.index)) continue;
    const key = `${intervalFor(entry.index, 'oldIndex')}\0${JSON.stringify(structuralRow(entry.row))}`;
    if (!oldGapGroups.has(key)) oldGapGroups.set(key, []);
    oldGapGroups.get(key).push(entry);
  }
  for (const unit of newUnits) for (const entry of unit) {
    if (newRowUsed.has(entry.index) || candidateByNewRow.has(entry.index)) continue;
    const key = `${intervalFor(entry.index, 'newIndex')}\0${JSON.stringify(structuralRow(entry.row))}`;
    if (!newGapGroups.has(key)) newGapGroups.set(key, []);
    newGapGroups.get(key).push(entry);
  }
  for (const [key, oldEntries] of oldGapGroups) {
    const newEntries = newGapGroups.get(key) || [];
    if (!oldEntries.length || oldEntries.length !== newEntries.length) continue;
    for (let i = 0; i < oldEntries.length; i += 1) {
      candidateByNewRow.set(newEntries[i].index, oldEntries[i]);
      candidateReasonByNewRow.set(newEntries[i].index, 'exact_structural_row_monotonic_gap');
    }
  }

  // Last exact-text pass: accept byte-for-byte identical originals within the
  // same module. Unique rows are direct; duplicates must have equal counts
  // inside the same pair of monotonic anchors.
  const reservedOldRows = new Set([...candidateByNewRow.values()].map(entry => entry.index));
  const remainingOldByOriginal = new Map(), remainingNewByOriginal = new Map();
  for (const unit of oldUnits) for (const entry of unit) {
    if (oldRowUsed.has(entry.index) || reservedOldRows.has(entry.index)) continue;
    if (!remainingOldByOriginal.has(entry.row.original)) remainingOldByOriginal.set(entry.row.original, []);
    remainingOldByOriginal.get(entry.row.original).push(entry);
  }
  for (const unit of newUnits) for (const entry of unit) {
    if (newRowUsed.has(entry.index) || candidateByNewRow.has(entry.index)) continue;
    if (!remainingNewByOriginal.has(entry.row.original)) remainingNewByOriginal.set(entry.row.original, []);
    remainingNewByOriginal.get(entry.row.original).push(entry);
  }
  for (const [original, oldEntries] of remainingOldByOriginal) {
    const newEntries = remainingNewByOriginal.get(original) || [];
    if (oldEntries.length !== 1 || newEntries.length !== 1) continue;
    candidateByNewRow.set(newEntries[0].index, oldEntries[0]);
    candidateReasonByNewRow.set(newEntries[0].index, 'exact_unique_original_row');
  }
  const reservedAfterUnique = new Set([...candidateByNewRow.values()].map(entry => entry.index));
  const oldOriginalGapGroups = new Map(), newOriginalGapGroups = new Map();
  for (const unit of oldUnits) for (const entry of unit) {
    if (oldRowUsed.has(entry.index) || reservedAfterUnique.has(entry.index)) continue;
    const key = `${intervalFor(entry.index, 'oldIndex')}\0${entry.row.original}`;
    if (!oldOriginalGapGroups.has(key)) oldOriginalGapGroups.set(key, []);
    oldOriginalGapGroups.get(key).push(entry);
  }
  for (const unit of newUnits) for (const entry of unit) {
    if (newRowUsed.has(entry.index) || candidateByNewRow.has(entry.index)) continue;
    const key = `${intervalFor(entry.index, 'newIndex')}\0${entry.row.original}`;
    if (!newOriginalGapGroups.has(key)) newOriginalGapGroups.set(key, []);
    newOriginalGapGroups.get(key).push(entry);
  }
  for (const [key, oldEntries] of oldOriginalGapGroups) {
    const newEntries = newOriginalGapGroups.get(key) || [];
    if (!oldEntries.length || oldEntries.length !== newEntries.length) continue;
    for (let i = 0; i < oldEntries.length; i += 1) {
      candidateByNewRow.set(newEntries[i].index, oldEntries[i]);
      candidateReasonByNewRow.set(newEntries[i].index, 'exact_original_row_monotonic_gap');
    }
  }
  const additionalRowPairs = [];
  const newEntryByIndex = new Map(newUnits.flat().map(entry => [entry.index, entry]));
  for (const [newIndex, oldEntry] of [...candidateByNewRow].sort((a, b) => a[0] - b[0])) {
    if (oldRowUsed.has(oldEntry.index) || newRowUsed.has(newIndex)) continue;
    additionalRowPairs.push({ oldEntry, newEntry: newEntryByIndex.get(newIndex), reason: candidateReasonByNewRow.get(newIndex) });
    oldRowUsed.add(oldEntry.index);
    newRowUsed.add(newIndex);
  }
  const oldEntryById = new Map(oldUnits.flat().map(entry => [entry.row.id, entry]));
  const newEntryById = new Map(newUnits.flat().map(entry => [entry.row.id, entry]));
  for (const override of manualOverrides.filter(item => item.module === module)) {
    const oldEntry = oldEntryById.get(override.oldId), newEntry = newEntryById.get(override.newId);
    if (!oldEntry || !newEntry) throw new Error(`${module}: manual override target was not found`);
    if (oldEntry.row.original !== newEntry.row.original || oldEntry.row.original !== override.original) {
      throw new Error(`${module}: manual override original differs`);
    }
    if (oldRowUsed.has(oldEntry.index) || newRowUsed.has(newEntry.index)) {
      const alreadyPaired = additionalRowPairs.some(pair => pair.oldEntry.index === oldEntry.index && pair.newEntry.index === newEntry.index);
      if (alreadyPaired) continue;
      throw new Error(`${module}: manual override target is already paired differently`);
    }
    additionalRowPairs.push({ oldEntry, newEntry, reason: 'manual_verified_exact_js_context' });
    oldRowUsed.add(oldEntry.index);
    newRowUsed.add(newEntry.index);
    manualOverridesApplied += 1;
  }
  newUnits.forEach((unit, newUnitIndex) => {
    if (unit.every(entry => newRowUsed.has(entry.index))) newUsed.add(newUnitIndex);
  });
  oldUnits.forEach((unit, oldUnitIndex) => {
    if (unit.every(entry => oldRowUsed.has(entry.index))) oldUsed.add(oldUnitIndex);
  });

  for (const [signature, oldIndices] of oldOriginalGroups) {
    const unresolvedOld = oldIndices.filter(index => oldUnits[index].some(entry => !oldRowUsed.has(entry.index)));
    const unresolvedNew = (newOriginalGroups.get(signature) || []).filter(index => newUnits[index].some(entry => !newRowUsed.has(entry.index)));
    if (!unresolvedOld.length && !unresolvedNew.length) continue;
    ambiguities.push({
      module,
      signatureSha1: sha1(signature),
      original: oldUnits[oldIndices[0]]?.[0].row.original ?? newUnits[unresolvedNew[0]]?.[0].row.original ?? '',
      oldUnitIndices: unresolvedOld,
      newUnitIndices: unresolvedNew,
      reason: 'exact_original_unit_not_uniquely_pairable',
    });
  }
  return { pairs, additionalRowPairs, oldUsed, newUsed, oldRowUsed, newRowUsed };
}

for (const newName of jsonNames(extractedDir)) {
  const module = moduleKey(newName);
  const oldName = oldByModule.get(module);
  const freshDoc = readJson(path.join(extractedDir, newName));
  const freshRows = [...freshDoc.rows].sort((a, b) => a.start - b.start || a.end - b.end);
  const newSourcePath = path.join(newRoot, 'resources', 'app', newName.slice(0, -5));
  const newSource = fs.readFileSync(newSourcePath, 'utf8');
  assertSourceRanges(freshRows, newSource, newName);

  const oldDoc = oldName ? readJson(path.join(baselineDir, oldName)) : { rows: [] };
  const oldRows = [...(oldDoc.rows || [])].sort((a, b) => a.start - b.start || a.end - b.end);
  let oldSource = '';
  if (oldName) {
    seenOldModules.add(module);
    const oldSourcePath = path.join(oldRoot, 'resources', 'app', oldName.slice(0, -5));
    oldSource = fs.readFileSync(oldSourcePath, 'utf8');
    assertSourceRanges(oldRows, oldSource, oldName);
  }

  const oldUnits = rowsAsUnits(oldRows);
  const newUnits = rowsAsUnits(freshRows);
  const matched = matchUnits(oldUnits, newUnits, oldSource, newSource, module);
  const rowsByNewIndex = new Map();
  const oldOrderStaging = [];

  for (const pair of matched.pairs.sort((a, b) => a.oldIndex - b.oldIndex)) {
    const oldUnit = oldUnits[pair.oldIndex];
    const newUnit = newUnits[pair.newIndex];
    if (oldUnit.length !== newUnit.length) throw new Error(`${module}: matched unit length changed`);
    for (let i = 0; i < oldUnit.length; i += 1) {
      const oldEntry = oldUnit[i];
      const newEntry = newUnit[i];
      if (oldEntry.row.original !== newEntry.row.original) {
        throw new Error(`${module}: exact-original match invariant failed`);
      }
      const inherited = inheritRow(newEntry.row, oldEntry.row, pair.reason);
      rowsByNewIndex.set(newEntry.index, inherited);
      oldOrderStaging.push({ oldIndex: oldEntry.index, newIndex: newEntry.index, row: inherited });
      inheritedAudit.push({ module, oldId: oldEntry.row.id, newId: newEntry.row.id, match: pair.reason });
    }
  }

  for (const pair of matched.additionalRowPairs) {
    const inherited = inheritRow(pair.newEntry.row, pair.oldEntry.row, pair.reason);
    rowsByNewIndex.set(pair.newEntry.index, inherited);
    oldOrderStaging.push({ oldIndex: pair.oldEntry.index, newIndex: pair.newEntry.index, row: inherited });
    inheritedAudit.push({ module, oldId: pair.oldEntry.row.id, newId: pair.newEntry.row.id, match: pair.reason });
  }
  oldOrderStaging.sort((a, b) => a.oldIndex - b.oldIndex || a.newIndex - b.newIndex);

  const appendedStaging = [];
  newUnits.forEach((unit) => {
    for (const entry of unit) {
      if (matched.newRowUsed.has(entry.index)) continue;
      const row = { ...entry.row, translation: '' };
      rowsByNewIndex.set(entry.index, row);
      appendedStaging.push({ newIndex: entry.index, row });
      newRecords.push({ file: newName, rowIndex: entry.index, id: row.id, original: row.original, reason: 'new_changed_or_ambiguous' });
    }
  });

  // Required staging order: inherited old records first, new/unmatched records at
  // the bottom. The persisted result is then restored to extracted_json order.
  const staged = [...oldOrderStaging, ...appendedStaging];
  if (staged.length !== freshRows.length || new Set(staged.map(item => item.newIndex)).size !== freshRows.length) {
    throw new Error(`${module}: staging did not cover every new row exactly once`);
  }
  const rows = freshRows.map((freshRow, index) => {
    const row = rowsByNewIndex.get(index);
    if (!row || row.id !== freshRow.id || row.start !== freshRow.start || row.end !== freshRow.end || row.raw !== freshRow.raw) {
      throw new Error(`${module}: final extracted-order restoration failed at ${index}`);
    }
    return row;
  });

  oldRows.forEach((row, rowIndex) => {
    if (matched.oldRowUsed.has(rowIndex)) return;
    oldUnmatched.push({ file: oldName, rowIndex, id: row.id, original: row.original, translation: row.translation || '', reason: 'removed_changed_or_ambiguous' });
  });

  const summary = summarizeRows(rows);
  const finalDoc = {
    ...freshDoc,
    ...summary,
    migration: {
      oldFile: oldName || null,
      matchingMode: 'exact_structure_then_exact_complete_original_unit',
      stagingOrder: 'old_inherited_then_new',
      finalOrder: 'new_extracted_json',
    },
    rows,
  };
  const extractedRows = freshRows.map((freshRow, index) => syncClassification(freshRow, rows[index]));
  const syncedExtractedDoc = {
    ...freshDoc,
    ...summarizeRows(extractedRows),
    rows: extractedRows,
  };
  writeJson(path.join(extractedDir, newName), syncedExtractedDoc);
  writeJson(path.join(outputDir, newName), finalDoc);
  files.push({
    module,
    oldFile: oldName || null,
    newFile: newName,
    oldRows: oldRows.length,
    newRows: freshRows.length,
    inheritedRows: oldOrderStaging.length,
    newOrUnmatchedRows: appendedStaging.length,
    oldUnmatchedRows: oldRows.length - oldOrderStaging.length,
  });
  console.log(`${module}: inherited=${oldOrderStaging.length}, new/unmatched=${appendedStaging.length}, old-unmatched=${oldRows.length - oldOrderStaging.length}`);
}

for (const [module, oldName] of oldByModule) {
  if (seenOldModules.has(module)) continue;
  const oldDoc = readJson(path.join(baselineDir, oldName));
  oldDoc.rows.forEach((row, rowIndex) => oldUnmatched.push({ file: oldName, rowIndex, id: row.id, original: row.original, translation: row.translation || '', reason: 'module_missing_in_new_version' }));
}

const totals = files.reduce((result, file) => ({
  oldRows: result.oldRows + file.oldRows,
  newRows: result.newRows + file.newRows,
  inheritedRows: result.inheritedRows + file.inheritedRows,
  newOrUnmatchedRows: result.newOrUnmatchedRows + file.newOrUnmatchedRows,
  oldUnmatchedRows: result.oldUnmatchedRows + file.oldUnmatchedRows,
}), { oldRows: 0, newRows: 0, inheritedRows: 0, newOrUnmatchedRows: 0, oldUnmatchedRows: 0 });

fs.mkdirSync(reportsDir, { recursive: true });
writeJson(path.join(reportsDir, 'migration_summary.json'), {
  generatedAt: new Date().toISOString(),
  matchingMode: 'exact_structure_then_exact_complete_original_unit',
  stateAuthority: 'old_translated_json',
  extractedStateSynchronized: true,
  totals,
  ambiguousGroups: ambiguities.length,
  manualOverrideProfile: selectedOverrideProfile ? {
    oldVersion,
    newVersion,
    configuredPairs: manualOverrides.length,
  } : null,
  manualOverridesApplied,
  files,
});
writeJson(path.join(reportsDir, 'matching_ambiguities.json'), { rows: ambiguities });
writeJson(path.join(reportsDir, 'old_unmatched.json'), { rows: oldUnmatched });
writeJson(path.join(reportsDir, 'new_records.json'), { rows: newRecords });
writeJson(path.join(reportsDir, 'inheritance_audit.json'), { rows: inheritedAudit });
console.log(JSON.stringify({ totals, ambiguousGroups: ambiguities.length }, null, 2));
