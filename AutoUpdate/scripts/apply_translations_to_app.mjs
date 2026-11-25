import fs from 'node:fs';
import path from 'node:path';
import { DIR, TRANSLATED, EXTRACTED, enabled, option, jsonFiles, sourceFor, sha1, parseJs, structureIssues, writeJson, rowUnits, approvedTranslationStatus } from './pipeline.mjs';

const output = path.join(DIR, 'translated_app');
const prepared = [];
const report = { generatedAt: new Date().toISOString(), files: [] };
const selectedFile = option('--file', '');
const summaryPath = path.join(DIR, 'apply_translations_summary.json');
const glossaryDir = path.join(DIR, 'glossary');
const localizedGlossaryPath = (localizedName, legacyName) => {
  const localized = path.join(glossaryDir, localizedName);
  return fs.existsSync(localized) ? localized : path.join(glossaryDir, legacyName);
};
const runtimeMappingPath = localizedGlossaryPath('mapping_en_zh.json', 'mapping.json');
const runtimeStructurePath = localizedGlossaryPath('mapping_struction_en_zh.json', 'mapping_struction.json');
const glossaryPath = localizedGlossaryPath('glossary_en_zh.json', 'glossary.json');

function collectRuntimeMappings(value, result = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry.original === 'string' && typeof entry.translation === 'string' && entry.translation) {
        const placeholders = Array.isArray(entry.placeholders) ? entry.placeholders : [entry.placeholder || ''];
        for (const placeholder of placeholders) result.push({ original: entry.original, translation: entry.translation, matchMode: entry.matchMode || 'exact', placeholder });
      } else collectRuntimeMappings(entry, result);
    }
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectRuntimeMappings(child, result);
  }
  return result;
}

function collectScopedDisplayExact(document, ranges) {
  const candidates = new Map();
  for (const row of document.rows || []) {
    if (!ranges.some(([start, end]) => row.line >= start && row.line <= end)) continue;
    if (!String(row.translationStatus || '').startsWith('manual_')) continue;
    if (typeof row.original !== 'string' || typeof row.translation !== 'string' || !row.original || !row.translation) continue;
    if (!candidates.has(row.original)) candidates.set(row.original, new Set());
    candidates.get(row.original).add(row.translation);
  }
  return [...candidates]
    .filter(([, translations]) => translations.size === 1)
    .map(([original, translations]) => [original, [...translations][0]]);
}

function installRuntimeDisplayMapping(source, file, document) {
  if (!/^main\.[\da-f]+\.js$/i.test(file) || !fs.existsSync(runtimeMappingPath)) return source;
  const mappingDocument = JSON.parse(fs.readFileSync(runtimeMappingPath, 'utf8'));
  const mappings = collectRuntimeMappings(mappingDocument);
  const structureDocument = fs.existsSync(runtimeStructurePath)
    ? JSON.parse(fs.readFileSync(runtimeStructurePath, 'utf8'))
    : { runtimeTemplates: [], functionMappings: {} };
  const runtimeTemplates = Array.isArray(structureDocument.runtimeTemplates) ? structureDocument.runtimeTemplates : [];
  const functionMappings = structureDocument.functionMappings && typeof structureDocument.functionMappings === 'object'
    ? structureDocument.functionMappings
    : {};
  const codexConfiguredExact = mappings.filter(entry => entry.matchMode === 'codexExact');
  const codexPhrases = mappings
    .filter(entry => entry.matchMode === 'codexPhrase' || entry.matchMode === 'codexExact')
    .sort((a, b) => b.original.length - a.original.length);
  const codexDisplayExact = [...new Map([
    ...collectScopedDisplayExact(document, [
    [601220, 605110],
    [611390, 622100],
    ]),
    ...codexConfiguredExact.map(entry => [entry.original, entry.translation]),
  ])];
  const glossaryDocument = fs.existsSync(glossaryPath) ? JSON.parse(fs.readFileSync(glossaryPath, 'utf8')) : {};
  const perkEntries = glossaryDocument?.['Game & Engine Mechanics']?.Perks;
  const perkDisplayExact = Array.isArray(perkEntries)
    ? perkEntries
      .filter(entry => entry && typeof entry.original === 'string' && typeof entry.translation === 'string' && entry.translation)
      .map(entry => [entry.original, entry.translation])
    : [];
  const shipEntries = glossaryDocument?.Locations?.Ships;
  const shipDisplayExact = [];
  if (Array.isArray(shipEntries)) {
    for (const entry of shipEntries) {
      if (!entry || typeof entry.original !== 'string' || typeof entry.translation !== 'string' || !entry.translation) continue;
      const originals = entry.original.split(' / ');
      const translations = entry.translation.split(' / ');
      if (originals.length === translations.length) {
        for (let index = 0; index < originals.length; index++) shipDisplayExact.push([originals[index], translations[index]]);
      } else shipDisplayExact.push([entry.original, entry.translation]);
    }
  }
  const exact = mappings.filter(entry => entry.matchMode === 'exact');
  const values = mappings.filter(entry => entry.matchMode === 'value');
  const beforeChinese = mappings.filter(entry => entry.matchMode === 'beforeChinese');
  const possessiveSuffixes = mappings.filter(entry => entry.matchMode === 'possessiveSuffix');
  const phrases = mappings
    .filter(entry => entry.matchMode === 'phrase' || entry.matchMode === 'component')
    .sort((a, b) => b.original.length - a.original.length);
  const helper = `\n      window.__titsCnRuntimeValue = (function () {\n        var rules = ${JSON.stringify(values)};\n        return function (tag, value) {\n          if (typeof value !== "string" || !value) return value;\n          var placeholder = String(tag || "").split(".").pop().toLowerCase();\n          for (var index = 0; index < rules.length; index++) {\n            var rule = rules[index];\n            if (rule.placeholder.toLowerCase() === placeholder && rule.original.toLowerCase() === value.toLowerCase()) return rule.translation;\n          }\n          return value;\n        };\n      })();\n      window.__titsCnRuntimeFunctionValue = (function () {\n        var groups = ${JSON.stringify(functionMappings)};\n        return function (name, value) {\n          if (typeof value !== "string" || !value) return value;\n          var rules = groups[name] || [];\n          for (var index = 0; index < rules.length; index++) {\n            if (String(rules[index].original).toLowerCase() === value.toLowerCase()) return rules[index].translation;\n          }\n          return value;\n        };\n      })();\n      window.__titsCnRuntimeMap = (function () {\n        var exact = new Map(${JSON.stringify(exact.map(entry => [entry.original, entry.translation]))});\n        var templates = ${JSON.stringify(runtimeTemplates)}.map(function (rule) {\n          return { pattern: new RegExp(rule.pattern, rule.flags || ""), replacement: rule.replacement };\n        });\n        var rules = ${JSON.stringify(phrases)};\n        var beforeChineseRules = ${JSON.stringify(beforeChinese)};\n        var possessiveSuffixRules = ${JSON.stringify(possessiveSuffixes)};\n        var escapeRegex = function (value) { return value.replace(/[.*+?^{}$()|[\\]\\\\]/g, "\\\\$&"); };\n        var mapVisibleText = function (value) {\n          if (exact.has(value)) return exact.get(value);\n          for (var templateIndex = 0; templateIndex < templates.length; templateIndex++) {\n            value = value.replace(templates[templateIndex].pattern, templates[templateIndex].replacement);\n          }\n          for (var index = 0; index < rules.length; index++) {\n            var rule = rules[index];\n            var pattern = new RegExp("(^|[^A-Za-z])(" + escapeRegex(rule.original) + ")(?=$|[^A-Za-z])", "gi");\n            value = value.replace(pattern, function (_, prefix) {\n              return prefix + "\\uE000" + rule.translation + "\\uE001";\n            });\n          }\n          value = value.replace(/\\uE001\\s+\\uE000/g, "").replace(/[\\uE000\\uE001]/g, "");\n          for (var contextIndex = 0; contextIndex < beforeChineseRules.length; contextIndex++) {\n            var contextRule = beforeChineseRules[contextIndex];\n            var contextPattern = new RegExp("(^|[^A-Za-z])(" + escapeRegex(contextRule.original) + ")(?=\\\\s*[\\\\u3400-\\\\u9fff])", "gi");\n            value = value.replace(contextPattern, function (_, prefix) { return prefix + contextRule.translation; });\n          }\n          for (var suffixIndex = 0; suffixIndex < possessiveSuffixRules.length; suffixIndex++) {\n            var suffixRule = possessiveSuffixRules[suffixIndex];\n            var suffixPattern = new RegExp("(?<=[\\\\u3400-\\\\u9fff])" + escapeRegex(suffixRule.original) + "\\\\s*(?=[\\\\u3400-\\\\u9fff])", "g");\n            value = value.replace(suffixPattern, suffixRule.translation);\n          }\n          return value\n            .replace(/\\uE001\\s+\\uE000/g, "")\n            .replace(/[\\uE000\\uE001]/g, "")\n            .replace(/(你|他|她|它|他们)的自己的/g, "$1自己的")\n            .replace(/的的/g, "的")\n            .replace(/(?<=[\\u3400-\\u9fff]) +(?=\\d)/g, "")\n            .replace(/(?<=\\d) +(?=[\\u3400-\\u9fff])/g, "")\n            .replace(/(?<=[\\u3400-\\u9fff]) +(?=[\\u3400-\\u9fff])/g, "")\n            .replace(/(?<=[\\u3400-\\u9fff]):/g, "：")\n            .replace(/： +(?=\\d)/g, "：")\n            .replace(/(?<=[\\u3400-\\u9fff])!(?=$|[^!])/g, "！")\n            .replace(/(?<=[\\u3400-\\u9fff])\\?(?=$|[^?])/g, "？")\n            .replace(/(?<=[\\u3400-\\u9fff])\\.(?!\\.)/g, "。");\n        };\n        return function (value) {\n          if (typeof value !== "string" || !value) return value;\n          return value.split(/(<[^>]*>)/g).map(function (part) {\n            return part.charAt(0) === "<" ? part : mapVisibleText(part);\n          }).join("");\n        };\n      })();\n`;
  const scopedDisplayHelper = `\n      window.__titsCnCodexMap = (function () {\n        var exact = new Map(${JSON.stringify(codexDisplayExact)});\n        var rules = ${JSON.stringify(codexPhrases)};\n        var escapeRegex = function (value) { return value.replace(/[.*+?^{}$()|[\\]\\\\]/g, "\\\\$&"); };\n        return function (value) {\n          if (typeof value !== "string" || !value) return value;\n          if (exact.has(value)) return exact.get(value);\n          for (var index = 0; index < rules.length; index++) {\n            var rule = rules[index];\n            value = value.replace(new RegExp("(^|[^A-Za-z])(" + escapeRegex(rule.original) + ")(?=$|[^A-Za-z])", "gi"), function (_, prefix) { return prefix + rule.translation; });\n          }\n          return value;\n        };\n      })();\n      window.__titsCnPerkMap = (function () {\n        var exact = new Map(${JSON.stringify(perkDisplayExact)});\n        return function (value) { return typeof value === "string" && exact.has(value) ? exact.get(value) : value; };\n      })();\n`;
  const shipDisplayHelper = `\n      window.__titsCnShipMap = (function () {\n        var exact = new Map(${JSON.stringify(shipDisplayExact)});\n        return function (value) { return typeof value === "string" && exact.has(value) ? exact.get(value) : value; };\n      })();\n`;
  let protectedRuntimeHelper = helper.replace(
    `        return function (value) {
          if (typeof value !== "string" || !value) return value;
          return value.split(/(<[^>]*>)/g).map(function (part) {
            return part.charAt(0) === "<" ? part : mapVisibleText(part);
          }).join("");
        };`,
    `        return function (value) {
          if (typeof value !== "string" || !value) return value;
          var output = "";
          var plainStart = 0;
          var flushPlain = function (end) {
            if (end > plainStart) output += mapVisibleText(value.slice(plainStart, end));
          };
          for (var index = 0; index < value.length;) {
            if (value.charAt(index) === "<") {
              var htmlEnd = value.indexOf(">", index + 1);
              if (htmlEnd >= 0) {
                flushPlain(index);
                output += value.slice(index, htmlEnd + 1);
                index = htmlEnd + 1;
                plainStart = index;
                continue;
              }
            }
            if (value.charAt(index) === "[") {
              var depth = 1;
              var parserEnd = index + 1;
              while (parserEnd < value.length && depth > 0) {
                if (value.charAt(parserEnd) === "[" && value.charAt(parserEnd - 1) !== "\\\\") depth++;
                else if (value.charAt(parserEnd) === "]" && value.charAt(parserEnd - 1) !== "\\\\") depth--;
                parserEnd++;
              }
              if (depth === 0) {
                flushPlain(index);
                output += value.slice(index, parserEnd);
                index = parserEnd;
                plainStart = index;
                continue;
              }
            }
            index++;
          }
          flushPlain(value.length);
          return output;
        };`,
  );
  protectedRuntimeHelper = protectedRuntimeHelper.replace(
    '.replace(/(?<=[\\u3400-\\u9fff])\\.(?!\\.)/g, "。");',
    '.replace(/(?<=[\\u3400-\\u9fff])\\.(?!\\.)/g, "。")\n            .replace(/\\.(?=\\s*$)/g, "。");',
  );
  protectedRuntimeHelper += `\n      window.__titsCnDeepMap = function (value) {\n        if (Array.isArray(value)) return value.map(window.__titsCnDeepMap);\n        if (typeof value !== "string") return value;\n        if (window.__titsCnRuntimeMap) value = window.__titsCnRuntimeMap(value);\n        return window.__titsCnCodexMap ? window.__titsCnCodexMap(value) : value;\n      };\n`;
  protectedRuntimeHelper = protectedRuntimeHelper.replace(
    '        return window.__titsCnCodexMap ? window.__titsCnCodexMap(value) : value;',
    '        if (window.__titsCnCodexMap) value = window.__titsCnCodexMap(value);\n        return window.__titsCnRuntimeMap ? window.__titsCnRuntimeMap(value) : value;',
  );
  protectedRuntimeHelper += `\n      window.__titsCnTheName = function (value) {\n        if (typeof value !== "string") return value;\n        if (window.__titsCnDeepMap) value = window.__titsCnDeepMap(value);\n        return value.replace(/^The\\s+/i, "");\n      };\n`;
  protectedRuntimeHelper = protectedRuntimeHelper.replace(
    '        if (typeof value !== "string") return value;\n        if (window.__titsCnDeepMap) value = window.__titsCnDeepMap(value);\n        return value.replace(/^The\\s+/i, "");',
    '        if (typeof value !== "string") return value;\n        if (window.__titsCnShipMap) {\n          var mapped = window.__titsCnShipMap(value);\n          if (mapped === value) mapped = window.__titsCnShipMap(value.replace(/^The\\s+/i, ""));\n          value = mapped;\n        }\n        if (window.__titsCnDeepMap) value = window.__titsCnDeepMap(value);\n        return value.replace(/^The\\s+/i, "");',
  );
  protectedRuntimeHelper = protectedRuntimeHelper.replace(
    '          var placeholder = String(tag || "").split(".").pop().toLowerCase();',
    '          var fullTag = String(tag || "").toLowerCase();\n          var placeholder = fullTag.split(".").pop();\n          if (fullTag === "pc_ship.thename" && window.__titsCnTheName) return window.__titsCnTheName(value);',
  );
  protectedRuntimeHelper = scopedDisplayHelper + shipDisplayHelper + protectedRuntimeHelper;
  if (protectedRuntimeHelper === helper) throw Error('Runtime mapping protection anchor not found');
  const installAnchor = '      c.simpleReplacements = {};';
  if (!source.includes(installAnchor)) throw Error('Runtime mapping install anchor not found');
  // Use a callback so replacement tokens such as "$&" inside the injected
  // regular-expression helper remain literal JavaScript source.
  source = source.replace(installAnchor, () => `${installAnchor}${protectedRuntimeHelper}`);
  const filterAnchor = `                    return e;\n                  },\n                },\n                {\n                  key: "tempParser",`;
  if (!source.includes(filterAnchor)) throw Error('Runtime mapping parser anchor not found');
  source = source.replace(filterAnchor, `                    return window.__titsCnRuntimeMap ? window.__titsCnRuntimeMap(e) : e;\n                  },\n                },\n                {\n                  key: "tempParser",`);
  const valueAnchors = [
    ['                                  b(G),', '                                  b(window.__titsCnRuntimeValue ? window.__titsCnRuntimeValue(A, G) : G),'],
    ['                                b(Z),', '                                b(window.__titsCnRuntimeValue ? window.__titsCnRuntimeValue(A, Z) : Z),'],
    ['                              b(q),', '                              b(window.__titsCnRuntimeValue ? window.__titsCnRuntimeValue(A, q) : q),'],
  ];
  for (const [from, to] of valueAnchors) {
    const count = source.split(from).length - 1;
    if (count !== 1) throw Error(`Runtime value mapping anchor count ${count}: ${from.trim()}`);
    source = source.replace(from, to);
  }
  const wrapFunctionReturn = (key, from, to) => {
    const start = source.indexOf(`key: "${key}"`);
    if (start < 0) throw Error(`Runtime function mapping key not found: ${key}`);
    const end = source.indexOf('\n                {\n                  key:', start + 1);
    if (end < 0) throw Error(`Runtime function mapping end not found: ${key}`);
    const block = source.slice(start, end);
    if (block.split(from).length - 1 !== 1) throw Error(`Runtime function mapping anchor mismatch: ${key}`);
    source = source.slice(0, start) + block.replace(from, to) + source.slice(end);
  };
  wrapFunctionReturn(
    'fluidViscosity',
    'return t.length <= 0 ? "fluid" : RandomInCollection(t);',
    'return window.__titsCnRuntimeFunctionValue("fluidViscosity", t.length <= 0 ? "fluid" : RandomInCollection(t));',
  );
  wrapFunctionReturn(
    'fluidNoun',
    'RandomInCollection(t)',
    'window.__titsCnRuntimeFunctionValue("fluidNoun", RandomInCollection(t))',
  );
  wrapFunctionReturn(
    'fluidColor',
    'RandomInCollection(t)',
    'window.__titsCnRuntimeFunctionValue("fluidColor", RandomInCollection(t))',
  );
  const buttonAnchor = '                  var u = (0, c.Z)(this.state.buttons);';
  if (source.split(buttonAnchor).length - 1 !== 1) throw Error('Runtime button mapping anchor count mismatch');
  source = source.replace(buttonAnchor, `                  window.__titsCnRuntimeMap && ((t = window.__titsCnRuntimeMap(t)), (a = window.__titsCnRuntimeMap(a)), (n = window.__titsCnRuntimeMap(n)));\n${buttonAnchor}`);
  const passiveButtonAnchor = '                    s = (0, c.Z)(this.state.buttons);';
  if (source.split(passiveButtonAnchor).length - 1 !== 2) throw Error('Runtime passive button mapping anchor count mismatch');
  source = source.replaceAll(passiveButtonAnchor, `                    s = (0, c.Z)(this.state.buttons);\n                  window.__titsCnRuntimeMap && ((t = window.__titsCnRuntimeMap(t)), (o = window.__titsCnRuntimeMap(o)), (a = window.__titsCnRuntimeMap(a)));`);
  const appearanceSidebarAnchor = `                          };
                        return y;
                      })(`;
  if (source.split(appearanceSidebarAnchor).length - 1 !== 1) throw Error('Runtime appearance sidebar mapping anchor count mismatch');
  source = source.replace(appearanceSidebarAnchor, `                          };
                        window.__titsCnRuntimeMap && ((y.buttonHeader = window.__titsCnRuntimeMap(y.buttonHeader)), (y.buttonText = window.__titsCnRuntimeMap(y.buttonText)));
                        return y;
                      })(`);
  const coreSidebarAnchor = `                      };
                    return f;
                  },
                  s = [],`;
  if (source.split(coreSidebarAnchor).length - 1 !== 1) throw Error('Runtime core sidebar mapping anchor count mismatch');
  source = source.replace(coreSidebarAnchor, `                      };
                    window.__titsCnRuntimeMap && ((f.buttonHeader = window.__titsCnRuntimeMap(f.buttonHeader)), (f.ttH = window.__titsCnRuntimeMap(f.ttH)), (f.ttB = window.__titsCnRuntimeMap(f.ttB)), (f.buttonText = window.__titsCnRuntimeMap(f.buttonText)));
                    return f;
                  },
                  s = [],`);
  const statusNameAnchor = `                  r = this.props.statusEffect.storageName
                    ? this.props.statusEffect.storageName
                    : "",
                  u = this.props.statusEffect.iconShade`;
  if (source.split(statusNameAnchor).length - 1 !== 1) throw Error('Runtime status name mapping anchor count mismatch');
  source = source.replace(statusNameAnchor, `                  r = this.props.statusEffect.storageName
                    ? this.props.statusEffect.storageName
                    : "",
                  r = window.__titsCnRuntimeMap ? window.__titsCnRuntimeMap(r) : r,
                  u = this.props.statusEffect.iconShade`);
  const statusHeaderAnchor = '                    "data-header": this.props.statusEffect.storageName,';
  if (source.split(statusHeaderAnchor).length - 1 !== 1) throw Error('Runtime status header mapping anchor count mismatch');
  source = source.replace(statusHeaderAnchor, '                    "data-header": r,');
  const statusBodyLabel = '                    "data-body": ';
  const statusHeaderIndex = source.indexOf('                    "data-header": r,');
  const statusBodyStart = source.indexOf(statusBodyLabel, statusHeaderIndex);
  const statusBodyEnd = source.indexOf(',\n                    "data-combat":', statusBodyStart);
  if (statusBodyStart < 0 || statusBodyEnd < 0) throw Error('Runtime status tooltip expression not found');
  const statusBodyExpression = source.slice(statusBodyStart + statusBodyLabel.length, statusBodyEnd);
  source = source.slice(0, statusBodyStart)
    + `${statusBodyLabel}window.__titsCnRuntimeMap ? window.__titsCnRuntimeMap(${statusBodyExpression}) : (${statusBodyExpression})`
    + source.slice(statusBodyEnd);
  const perkNameAnchor = `                  key: "perkNameDisplay",
                  get: function () {
                    return "" !== this.perkNameSilly
                      ? this.perkNameSilly
                      : "" !== this.perkName
                        ? this.perkName
                        : this.perkShortName;
                  },`;
  if (source.split(perkNameAnchor).length - 1 !== 1) throw Error('Runtime perk display anchor count mismatch');
  source = source.replace(perkNameAnchor, `                  key: "perkNameDisplay",
                  get: function () {
                    var e = "" !== this.perkNameSilly
                      ? this.perkNameSilly
                      : "" !== this.perkName
                        ? this.perkName
                        : this.perkShortName;
                    return window.__titsCnPerkMap ? window.__titsCnPerkMap(e) : e;
                  },`);
  const wrapShipName = expression => `window.__titsCnTheName ? window.__titsCnTheName(${expression}) : ${expression}`;
  const shipLongNameAnchor = '.concat(this.theName, "</i>")';
  if (source.split(shipLongNameAnchor).length - 1 !== 1) throw Error('Ship long-description theName anchor mismatch');
  source = source.replace(shipLongNameAnchor, `.concat(${wrapShipName('this.theName')}, "</i>")`);
  const wrapShipNamesInBlock = (startAnchor, endAnchor, pattern, expectedCount, label) => {
    const start = source.indexOf(startAnchor);
    const end = source.indexOf(endAnchor, start + startAnchor.length);
    if (start < 0 || end < 0) throw Error(`${label} source block not found`);
    const block = source.slice(start, end);
    const matches = block.match(pattern) || [];
    if (matches.length !== expectedCount) throw Error(`${label} theName count ${matches.length}, expected ${expectedCount}`);
    source = source.slice(0, start)
      + block.replace(pattern, expression => wrapShipName(expression))
      + source.slice(end);
  };
  wrapShipNamesInBlock(
    'key: "storedShipsMenu"',
    'key: "shipActionConfirmPrompt"',
    /\b(?:n|pc_ship|o|t)\.theName\b/g,
    14,
    'Ship management UI',
  );
  wrapShipNamesInBlock(
    'flags.KIRO_SHIP_LOOTED = 1',
    'void 0 === flags.KIRO_LOVED',
    /\b(?:a|i)\.theName\b/g,
    3,
    'Kiro ship-storage UI',
  );
  const expandableMapAnchor = `          n = "";
        return (`;
  let expandableStatsStart = -1;
  let expandableStatsEnd = -1;
  let expandableSearchIndex = 0;
  while ((expandableSearchIndex = source.indexOf(expandableMapAnchor, expandableSearchIndex)) >= 0) {
    const candidateStart = source.lastIndexOf('      function ', expandableSearchIndex);
    const candidateEnd = source.indexOf('      function ', expandableSearchIndex + expandableMapAnchor.length);
    const candidateBlock = candidateStart >= 0 && candidateEnd >= 0 ? source.slice(candidateStart, candidateEnd) : '';
    if (candidateBlock.includes('toggle_text_container') && candidateBlock.includes('toggleStatsView')) {
      expandableStatsStart = candidateStart;
      expandableStatsEnd = candidateEnd;
      break;
    }
    expandableSearchIndex += expandableMapAnchor.length;
  }
  if (expandableStatsStart < 0 || expandableStatsEnd < 0) throw Error('Expandable stats helper block not found');
  const expandableStatsBlock = source.slice(expandableStatsStart, expandableStatsEnd);
  if (expandableStatsBlock.split(expandableMapAnchor).length - 1 !== 1) throw Error('Expandable stats mapping anchor mismatch');
  source = source.slice(0, expandableStatsStart)
    + expandableStatsBlock.replace(expandableMapAnchor, `          n = "";
        window.__titsCnDeepMap && ((t = window.__titsCnDeepMap(t)), (a = window.__titsCnDeepMap(a)));
        return (`)
    + source.slice(expandableStatsEnd);
  const statsTableAnchor = `        function i(e) {
          var t = "";
          ((t += re.m.createTable(
            e,
            ["", "per", "min", "cur", "max", "mod"],`;
  if (source.split(statsTableAnchor).length - 1 !== 1) throw Error('Statistics table mapping anchor mismatch');
  source = source.replace(statsTableAnchor, `        function i(e) {
          var t = "";
          window.__titsCnDeepMap && (e = window.__titsCnDeepMap(e));
          ((t += re.m.createTable(
            e,
            window.__titsCnDeepMap ? window.__titsCnDeepMap(["", "per", "min", "cur", "max", "mod"]) : ["", "per", "min", "cur", "max", "mod"],`);
  const itemFlagStart = source.indexOf('key: "showItemFlagInfo"');
  const itemFlagEnd = source.indexOf('key: "itemStatBlockString"', itemFlagStart + 1);
  if (itemFlagStart < 0 || itemFlagEnd < 0) throw Error('Item flag display block not found');
  let itemFlagBlock = source.slice(itemFlagStart, itemFlagEnd);
  const itemFlagDisplayAnchor = '                  var g = "";';
  if (itemFlagBlock.split(itemFlagDisplayAnchor).length - 1 !== 1) throw Error('Item flag display mapping anchor mismatch');
  itemFlagBlock = itemFlagBlock.replace(itemFlagDisplayAnchor, `                  window.__titsCnDeepMap && ((i = window.__titsCnDeepMap(i)), (s = window.__titsCnDeepMap(s)), (r = window.__titsCnDeepMap(r)));
                  var g = "";`);
  source = source.slice(0, itemFlagStart) + itemFlagBlock + source.slice(itemFlagEnd);
  const injectDisplayMapping = (pattern, replacement, minimum, label) => {
    let count = 0;
    source = source.replace(pattern, (...args) => {
      count += 1;
      return replacement(...args);
    });
    if (count < minimum) throw Error(`Runtime display helper anchor mismatch: ${label}`);
  };
  injectDisplayMapping(
    /(      function [A-Za-z_$][\w$]*\(e, t\) \{\n)(        output\(re\.m\.li\(e, t\)\);)/g,
    (_, head, body) => `${head}        window.__titsCnDeepMap && ((e = window.__titsCnDeepMap(e)), (t = window.__titsCnDeepMap(t)));\n${body}`,
    1,
    'two-argument list item',
  );
  injectDisplayMapping(
    /(      function [A-Za-z_$][\w$]*\(e, t\) \{\n        var o = arguments\.length > 2 && void 0 !== arguments\[2\] && arguments\[2\];\n)(        output\(re\.m\.li\(e, t, o\)\);)/g,
    (_, head, body) => `${head}        window.__titsCnDeepMap && ((e = window.__titsCnDeepMap(e)), (t = window.__titsCnDeepMap(t)));\n${body}`,
    1,
    'three-argument list item',
  );
  injectDisplayMapping(
    /(      function [A-Za-z_$][\w$]*\(e, t, o\) \{\n)(        return re\.m\.ld\(e, t, o\);)/g,
    (_, head, body) => `${head}        window.__titsCnDeepMap && ((e = window.__titsCnDeepMap(e)), (t = window.__titsCnDeepMap(t)));\n${body}`,
    1,
    'list detail',
  );
  injectDisplayMapping(
    /(      function [A-Za-z_$][\w$]*\(e, t, o, a\) \{\n)(        return re\.m\.ldNest\(e, t, o, a\);)/g,
    (_, head, body) => `${head}        window.__titsCnDeepMap && ((e = window.__titsCnDeepMap(e)), (t = window.__titsCnDeepMap(t)), (o = window.__titsCnDeepMap(o)));\n${body}`,
    1,
    'nested list detail',
  );
  injectDisplayMapping(
    /(      function [A-Za-z_$][\w$]*\(e\) \{\n        var t =\n          !\(arguments\.length > 1[^]*?\n)(        output\(re\.m\.h3\(e, t\)\);)/g,
    (_, head, body) => `${head}        window.__titsCnDeepMap && (e = window.__titsCnDeepMap(e));\n${body}`,
    1,
    'section heading',
  );
  injectDisplayMapping(
    /(      function [A-Za-z_$][\w$]*\(e\) \{\n)(        output\(\n          [A-Za-z_$][\w$]*\(\n            e,)/g,
    (_, head, body) => `${head}        window.__titsCnDeepMap && (e = window.__titsCnDeepMap(e));\n${body}`,
    1,
    'encounter section heading',
  );
  return source;
}
// A targeted writeback must not erase the summary entries for every other
// translated chunk; launch_cn.ps1 uses this list to verify the runtime overlay.
if (selectedFile && fs.existsSync(summaryPath)) {
  const existing = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  if (Array.isArray(existing.files)) report.files.push(...existing.files.filter(file => file.file !== selectedFile));
}
for (const input of jsonFiles(path.resolve(option('--input', TRANSLATED)))) {
  const doc = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (selectedFile && doc.file !== selectedFile) continue;
  const originalDoc = JSON.parse(fs.readFileSync(path.join(EXTRACTED, `${doc.file}.json`), 'utf8'));
  if (doc.sourceSha1 !== originalDoc.sourceSha1) throw Error(`Extraction mismatch: ${doc.file}`);
  const originals = new Map(originalDoc.rows.map(r => [r.id, r]));
  const source = sourceFor(doc), edits = [];
  for (const unit of rowUnits(doc.rows)) {
    const first = unit[0];
    if (!unit.every(r => enabled(r) && typeof r.translation === 'string' && r.translationStatus !== 'failed')) continue;
    // An explicitly approved empty translation is meaningful for English-only
    // inflection fragments such as "s", "y", and "ies" in Chinese joins.
    if (!unit.some(r => r.translation.trim() || approvedTranslationStatus(r))) continue;
    // A translation frontier can stop in the middle of a dynamic string unit.
    // Never publish only the translated prefix/suffix: leave the whole unit in
    // the source until every fragment has been explicitly approved.
    if (!unit.every(approvedTranslationStatus)) continue;
    for (const row of unit) {
      const original = originals.get(row.id);
      if (!original) throw Error(`Unknown extracted row: ${row.id}`);
      if (enabled(original) !== enabled(row)) throw Error(`Classification state mismatch; resync extracted_json: ${row.id}`);
      for (const key of ['original', 'start', 'end', 'raw', 'unitId']) if (row[key] !== original[key]) throw Error(`Changed extraction metadata ${key}: ${row.id}`);
      if (JSON.stringify(row.joinAfter) !== JSON.stringify(original.joinAfter)) throw Error(`Changed expression: ${row.id}`);
      if (source.slice(row.start, row.end) !== row.raw) throw Error(`Source slice mismatch: ${row.id}`);
    }
    const join = key => unit.map(r => r[key] + (r.joinAfter?.token || '')).join('');
    const issues = structureIssues(join('original'), join('translation'));
    // manual_abnormal is assigned only after source-JS review for exceptional
    // units such as visible bracketed notices that resemble placeholders.
    if (issues.length && !unit.every(row => row.translationStatus === 'manual_abnormal')) {
      throw Error(`Unsafe translation ${first.id}: ${issues.join('; ')}`);
    }
    for (const row of unit) {
      const literal = JSON.stringify(row.translation).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      edits.push({ start: row.start, end: row.end, literal });
    }
  }
  edits.sort((a, b) => a.start - b.start);
  let cursor = 0;
  const parts = [];
  for (const edit of edits) {
    if (edit.start < cursor) throw Error(`Overlapping edits: ${doc.file}`);
    parts.push(source.slice(cursor, edit.start), edit.literal); cursor = edit.end;
  }
  parts.push(source.slice(cursor));
  const result = installRuntimeDisplayMapping(parts.join(''), doc.file, doc);
  parseJs(result);
  if (edits.length) prepared.push({ file: doc.file, result });
  report.files.push({ file: doc.file, replacements: edits.length, sourceSha1: sha1(source), outputSha1: sha1(result), syntaxValid: true });
}
// Do not publish any output until every document and replacement has passed validation.
fs.mkdirSync(output, { recursive: true });
for (const { file, result } of prepared) fs.writeFileSync(path.join(output, file), result);
report.files.sort((a, b) => a.file.localeCompare(b.file));
writeJson(summaryPath, report);
for (const file of report.files) console.log(`${file.file}: ${file.replacements} replacements; syntax OK`);
