import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, EXTRACTED, parseJs, sha1, writeJson, option, rowUnits } from './pipeline.mjs';

// Read the user's already formatted sources verbatim. No formatter or game code is executed.
const displayProperties = new Set(['short', 'long', 'longName', 'fullName', 'description', 'descriptionm', 'desc', 'tooltip', 'title', 'text', 'label', 'message', 'locationName', 'roomName', 'caption', 'buttonName', 'menuName', 'plural', 'a', 'article', 'displayName', 'storageName', 'attackNoun', 'innerHTML', 'unlockedDescription', 'lockedDescription', 'perkDescription', 'customDodge', 'customBlock', 'ttH', 'ttB', 'ttBody', 'TooltipBody', 'subject', 'body', 'content', 'dttB', 'ttb', 'toolty', 'lookCloserTxt', 'OnTakeDamageOutput', 'keeperBuy', 'keeperSell', 'keeperGreeting', 'output', 'btnTTB', 'btnTB', 'footer', 'msg', 'poor', 'good', 'ownd', 'drinkMe', 'panty', 'tb', 'action', 'set', 'tt', 'from', 'data-body', '__html', 'req', 'th', 'menuButton', 'dataButton', 'quickSaveButton', 'statsButton', 'mailsButton', 'perksButton', 'levelUpButton', 'appearanceButton', 'buttonPageNext', 'buttonPagePrev', 'bufferPageNext', 'bufferPagePrev', 'U.Top Off', 'Shield Off', 'U.Wear Off', 'Melee Off', 'Armor Off', 'Ranged Off', 'Acc. Off']);
const reviewProperties = new Set(['name']);
const proseCalls = new Set(['output', 'outputB', 'outputText', 'combatOutput', 'combatAppend', 'textify', 'blockHeader', 'parseText', 'ParseText', 'AddLogEvent', 'ExtendLogEvent', 'addTooltip', 'setTooltip', 'setDescription', 'showText', 'setText']);
const diagnosticCalls = new Set(['Error', 'TypeError', 'ReferenceError', 'Zb', '$v']);
const keyCalls = new Set(['moveToRoom', 'skipToRoom', 'skipShipToRoom', 'moveShipToRoom', 'hasKeyItem', 'getKeyItem', 'createKeyItem', 'removeKeyItem', 'hasStatusEffect', 'getStatusEffect', 'createStatusEffect', 'removeStatusEffect', 'statusEffectv1', 'addStatusValue', 'setStatusMinutes', 'getStat', 'track', 'querySelector', 'author']);
const nonTextCalls = new Set(['showImage', 'showBust', 'showPortrait', 'parse', 'set', 'keyItemv1', 'statusEffectv2', 'displayLocation']);
// String arguments at these positions are selectors, enum values, DOM tag names,
// CSS hooks or state keys. They may sit inside a larger output concatenation, but
// changing them still changes program behaviour rather than player-facing text.
// Keep this argument-level: several neighbouring arguments (for example
// colorPicker[0], createButton[0]/[5], and setStatusTooltip[1]) are genuine UI
// labels or descriptions and must remain translatable.
const nonTextCallArguments = new Map([
  ['getCombatPronoun', '*'],
  ['getCombatName', '*'],
  ['createElement', new Set([0])],
  ['svgIcon', new Set([0])],
  ['svgInlineIcon', new Set([0])],
  ['mannequinPart', new Set([0])],
  ['toggleButtons', new Set([0])],
  ['valueButtons', new Set([0])],
  ['flagToggleButtons', new Set([0])],
  ['colorPicker', new Set([1])],
  ['createButton', new Set([4, 6, 8, 9, 10])],
  ['createInput', new Set([0, 1])],
  ['animateText', new Set([1])],
  ['printStatChange', new Set([2, 3])],
  ['getInputLimit', new Set([0])],
  ['getStatusMinutes', new Set([0])],
  ['getStatusTooltip', new Set([0])],
  ['setStatusTooltip', new Set([0])],
  ['setStatusHidden', new Set([0])],
  ['setStatusIconShade', new Set([0, 1])],
  ['setStatusValue', new Set([0])],
  ['statusEffectv1', new Set([0])],
  ['statusEffectv2', new Set([0])],
  ['statusEffectv3', new Set([0])],
  ['statusEffectv4', new Set([0])],
  ['perkv1', new Set([0])],
  ['renderDeveloperType', new Set([1])],
  ['renderAchievementType', new Set([1])],
  ['clearDisarmed', new Set([0])],
  ['keybind', new Set([0])],
  ['headerSegment', new Set([1, 2])],
  ['listBackers', new Set([1])],
  ['backerButtonControls', new Set([0])],
  ['ty', new Set([0, 1])],
  ['mapFullEffectDummy', new Set([0])],
  ['mapTileEffectDummy', new Set([2])],
  ['convertCircuitID', new Set([1])],
  ['svgSwitchTile', new Set([0])],
  ['svgCircuitTile', new Set([0])],
]);
const nonTextProperties = new Set(['name', 'd', 'className', 'bindClasses', 'gridTemplateColumns', 'gridTemplateRows', 'animation', 'animationName', 'cssText', 'style', 'transform', 'viewBox', 'points', 'fill', 'stroke', 'clipPath', 'mask', 'boxShadow', 'loc', 'index', 'statusName', 'nativeTrackedStat', 'DisabledIfEffectedBy', 'textArea', 'Ejaculation Volume, Total Ejaculated', 'Female Ejaculation Volume, Total Ejaculated']);
// These non-minified helpers are defined in this build as output/list-markup wrappers.
// Their string arguments are rendered in the log, quest, appearance or statistics UI.
const textHelperCalls = new Set(['eV', 'lS', 'zL', 'uS', 'TL', 'CL', 'cS', 'li']);
const genericTextContainers = new Set(['ArrayExpression', 'AssignmentExpression', 'ReturnStatement', 'VariableDeclarator', 'SequenceExpression', 'ConditionalExpression']);
function nameOf(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  if (node.type === 'MemberExpression') return nameOf(node.property);
  if (node.type === 'SequenceExpression') return nameOf(node.expressions.at(-1));
  return '';
}
export function isNonTextCallArgument(name, arg) {
  const positions = nonTextCallArguments.get(name);
  return positions === '*' || positions?.has(arg) || false;
}
function classify(node, stack) {
  let child = node;
  let fallbackContext = '';
  for (let i = stack.length - 1; i >= 0; i--) {
    const p = stack[i];
    if (p.type === 'BinaryExpression' && p.operator === '+') { child = p; continue; }
    if (p.type === 'ConditionalExpression' && p.test !== child) { child = p; continue; }
    if (p.type === 'LogicalExpression' && p.right === child) { child = p; continue; }
    if (p.type === 'TemplateLiteral' || p.type === 'ChainExpression') { child = p; continue; }
    if (p.type === 'MemberExpression' && p.object === child && nameOf(p.property) === 'concat') { child = p; continue; }
    if (p.type === 'ArrayExpression') { fallbackContext ||= 'ArrayExpression'; child = p; continue; }
    if (p.type === 'CallExpression') {
      const name = nameOf(p.callee), arg = p.arguments.indexOf(child);
      if (name === 'concat' && p.callee.type === 'MemberExpression') { child = p; continue; }
      if (arg < 0) return ['code', 'callee'];
      if (isNonTextCallArgument(name, arg)) return ['code', `${name}[${arg}]`];
      if (diagnosticCalls.has(name)) return ['code', `${name}[${arg}]`];
      if (nonTextCalls.has(name)) return ['code', `${name}[${arg}]`];
      if (textHelperCalls.has(name)) return ['ui_text', `${name}[${arg}]`];
      if (proseCalls.has(name) && (arg === 0 || name === 'textify')) return ['dialogue', `${name}[${arg}]`];
      if (name === 'showName' && arg <= 1) return ['speaker', `${name}[${arg}]`];
      if (name === 'addButton' && [1, 3, 4, 5].includes(arg)) return ['button_or_tooltip', `${name}[${arg}]`];
      // addFlatButton(index, title, tooltipHeader, tooltipBody, tooltipFooter, tooltipItem)
      // has no callback argument, so its visible tooltip fields begin at index 2.
      if (name === 'addFlatButton' && [1, 2, 3, 4].includes(arg)) return ['button_or_tooltip', `${name}[${arg}]`];
      if (name === 'addGatedButton' && [1, 3, 4, 6, 7].includes(arg)) return ['button_or_tooltip', `${name}[${arg}]`];
      if (name === 'addDisabledButton' && [1, 2, 3, 4].includes(arg)) return ['button_or_tooltip', `${name}[${arg}]`];
      if (name === 'showDialog' && [1, 2].includes(arg)) return ['ui_text', `${name}[${arg}]`];
      if (name === 'createElement' && arg >= 2) return ['ui_text', `${name}[${arg}]`];
      if (name === 'createStatusEffect' && arg === 7) return ['status_text', `${name}[${arg}]`];
      if (name === 'createPerk' && arg === 5) return ['status_text', `${name}[${arg}]`];
      if (name === 'createKeyItem' && arg === 5) return ['property_text', `${name}[${arg}]`];
      if (['setStatusTooltip', 'setPerkTooltip'].includes(name) && arg === 1) return ['status_text', `${name}[${arg}]`];
      if (['applyStun', 'applyGrapple', 'applyParalyze'].includes(name) && arg === 3) return ['status_text', `${name}[${arg}]`];
      if (name === 'setButtonTooltipData' && arg === 2) return ['button_or_tooltip', `${name}[${arg}]`];
      if (name === 'addShipCompareButton' && arg === 7) return ['button_or_tooltip', `${name}[${arg}]`];
      if (name === 'addItemDisabledButton' && arg === 3) return ['button_or_tooltip', `${name}[${arg}]`];
      if (name === 'lockItemSlot' && arg === 1) return ['ui_text', `${name}[${arg}]`];
      if (name === 'sendMail' && arg === 2) return ['dialogue', `${name}[${arg}]`];
      if (name === 'createReorganizationListMenu' && arg === 2) return ['ui_text', `${name}[${arg}]`];
      if (name === 'createTable' && arg === 5) return ['ui_text', `${name}[${arg}]`];
      if (name === 'shipActionConfirmPrompt' && arg === 4) return ['ui_text', `${name}[${arg}]`];
      if (name === 'badEnd' && arg === 0) return ['ui_text', `${name}[${arg}]`];
      if (name === 'header' && arg === 0) return ['ui_text', `${name}[${arg}]`];
      if (keyCalls.has(name)) return ['code', `${name}[${arg}]`];
      fallbackContext ||= `${name || '(anonymous)'}[${arg}]`;
      child = p;
      continue;
    }
    if (p.type === 'AssignmentExpression' && p.right === child && p.left.type === 'MemberExpression') {
      const prop = nameOf(p.left);
      return [displayProperties.has(prop) ? 'property_text' : reviewProperties.has(prop) ? 'review' : 'code', `assignment.${prop}`];
    }
    if (p.type === 'Property') {
      if (p.key === child || p.computed || p.method) return ['code', 'object_key'];
      const prop = nameOf(p.key);
      return [displayProperties.has(prop) ? 'property_text' : reviewProperties.has(prop) ? 'review' : 'code', `property.${prop}`];
    }
    return ['code', fallbackContext || p.type];
  }
  return ['code', fallbackContext || 'program'];
}
function hasWords(value, context = '') {
  const visible = value.replace(/<[^>]*>|\[[^\]]*\]|&\w+;/g, '');
  if (/[A-Za-z]/.test(visible)) return true;
  // A complete conditional parser expression can contain all of its visible
  // prose inside one outer [...] pair.  It still needs translation even though
  // the simple placeholder-stripping expression above removes the whole value.
  if (/\[[A-Za-z][^\]|]*\|[\s\S]*[A-Za-z]/.test(value)) return true;
  // Disabled-button titles sometimes deliberately display literal brackets,
  // for example "[Locked]" or "\\[Too Silly\\]".  Restrict this exception
  // to button display/tooltip arguments and plain words so parser placeholders
  // such as [pc.name] and incomplete parser fragments remain protected.
  if (/^(?:addButton|addFlatButton|addGatedButton|addDisabledButton)\[(?:1|2|3|4|5|6|7)\]$/.test(context)) {
    return /^\\?\[[A-Z][a-z]+(?: [A-Z][a-z]+)*\\?\]$/.test(value.trim());
  }
  return false;
}
function asset(value) {
  return /^\s*(?:https?:\/\/|data:|#[\da-f]{3,8}\s*$)/i.test(value) || /^[\w./\\:@-]+\.(?:png|jpe?g|gif|svg|webp|js|css|json|ogg|mp3|woff2?)$/i.test(value);
}
function standaloneInternalIdentifier(value) {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value.trim());
}
function cssClassList(value) {
  const t = value.trim();
  return /^(?:(?:text|row|col|column|btn|button|grid|flex|align|justify|display|position|float|clear|margin|padding|width|height)-[a-z0-9_-]+|nowrap)(?:\s+(?:(?:text|row|col|column|btn|button|grid|flex|align|justify|display|position|float|clear|margin|padding|width|height)-[a-z0-9_-]+|nowrap))*$/i.test(t);
}
function looksLikeDiagnosticOrCode(value) {
  const t = value.trim();
  if (!t) return true;
  if (/^(?:ERROR|WARNING|Invalid attempt|Unhandled|Uncaught|Expected\b|Unknown (?:value|type|case)|Failed to\b|Could not find\b)/i.test(t)) return true;
  // A bracketed [flags.SOME_FLAG |...] construct is TiTS player-text syntax,
  // not a JavaScript flag reference.  Keep protecting bare diagnostic/code
  // references while allowing the game parser form through classification.
  if (/\b(?:unhandled switch case|no implementation|not a number|expected (?:undefined|array|number|string)|received undefined|document\.getElementById|querySelector|console\.|stack trace)\b/i.test(t) || /(?<!\[)\bflags\.[A-Z0-9_]+\b/i.test(t)) return true;
  if (/^M\s*-?\d+(?:\.\d+)?\s/i.test(t)) return true; // SVG path data.
  if (/<\/?(?:svg|defs|clipPath|linearGradient|mask|stop|path|rect|g|text|tspan)\b/i.test(t)) return true;
  if (/^(?:><(?:label|select)\b|["']?\s*(?:class|id|style|for|defaultValue|onclick)=)/i.test(t)) return true;
  if (/^<(?:select|label|span|div|button|option)\b[^>]*$/i.test(t)) return true;
  if (/^(?:[A-Za-z][\w-]*\s+){2,}[A-Za-z][\w-]*$/.test(t) && t.split(/\s+/).every(token => /_|-|[a-z][A-Z]/.test(token))) return true;
  if (/^[A-Z][A-Z0-9_]+:\s*$/.test(t) || /(?:Full Pregnancy (?:Message \d+|Bellyrubs|Almost Due))$/.test(t) || /^Lane's Hypnosis - /.test(t)) return true;
  if (/<[A-Za-z][^>]*>/.test(t)) {
    const visible = t.replace(/<[^>]*>|&(?:[A-Za-z]+|#\d+|#x[\da-f]+);/gi, '').trim();
    if (/^(?:[BIUS]|SVG|PNG)$/.test(visible)) return true;
  }
  // Only treat declarations as code when they begin the literal.  The previous
  // alternation anchored only the first branch, so ordinary prose containing
  // phrases such as "let her" anywhere in the text was incorrectly protected.
  if (/^(?:\[?\{|function\b|(?:const|let|var)\s+[A-Za-z_$])/.test(t) || /=>\s*(?:\{|[A-Za-z_$])/.test(t)) return true;
  if (/[{}]\s*(?:\r?\n|$)/.test(t)) return true;
  const semicolonLines = t.match(/;\s*(?:\r?\n|$)/g) || [];
  if (semicolonLines.length >= 2 && (/=>/.test(t) || /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/m.test(t) || /^\s*function\s+[A-Za-z_$][\w$]*\s*\(/m.test(t))) return true;
  if (/^[A-Z0-9_' .:&-]+(?:\.[A-Z0-9_' .:&-]+){1,}$/.test(t)) return true; // room/save route.
  return false;
}
function visibleHtmlText(value) {
  if (!/<[A-Za-z][^>]*>/.test(value)) return false;
  const visible = value.replace(/<[^>]*>|&(?:[A-Za-z]+|#\d+|#x[\da-f]+);/gi, ' ').replace(/\s+/g, ' ').trim();
  return /[A-Za-z]{2}/.test(visible) && !/^[A-Z]{2,5}$/.test(visible);
}
function isTechnicalDiagnostic(value) {
  const t = value.replace(/<[^>]*>/g, '').trim();
  return /^(?:ERROR\b|ERROR[!:.]|Error:\s|Invalid attempt\b|Unhandled\b|Uncaught\b|TypeError\b|ReferenceError\b)/i.test(t) ||
    /^(?:THIS SHOULDN[’']T HAPPEN\b|This room should never be entered\b)/i.test(t) ||
    /\bPLEASE (?:COPY ?PASTE|INCLUDE) THIS IN A BUG REPORT\b/i.test(t) ||
    /\b(?:unhandled switch case|does not exist\.?(?:\s|$)|no implementation for|is not a number|expected (?:undefined|array|number|string), received|passed to [A-Za-z_$][\w$]*$)\b/i.test(t);
}
function forcedCodeContext(context) {
  const property = context.match(/^(?:property|assignment)\.(.+)$/)?.[1];
  if (property && nonTextProperties.has(property)) return true;
  if (['NewExpression', 'ThrowStatement', 'SwitchCase'].includes(context)) return true;
  const callArgument = context.match(/^(.+)\[(\d+)\]$/);
  if (callArgument && isNonTextCallArgument(callArgument[1], Number(callArgument[2]))) return true;
  if ([...diagnosticCalls].some(name => context.startsWith(`${name}[`))) return true;
  if (context === 'createStatusEffect[7]' || context === 'createKeyItem[5]') return false;
  if ([...keyCalls].some(name => context.startsWith(`${name}[`))) return true;
  if ([...nonTextCalls].some(name => context.startsWith(`${name}[`))) return true;
  return false;
}
function strongPlayerText(value, context) {
  if (looksLikeDiagnosticOrCode(value) || asset(value)) return false;
  const visible = value.replace(/<[^>]*>|\[[^\]]*\]|&\w+;/g, ' ');
  const words = visible.match(/[A-Za-z]+(?:[’'][A-Za-z]+)*/g) || [];
  const rich = /[.!?,:;…“”]|<\/?(?:i|b|u|li|p|div|span|br)\b|\[[^\]]+\]|\r?\n/i.test(value);
  const html = /<\/?(?:i|b|u|li|p|div|span|br)\b/i.test(value);
  const parser = /\[[^\]]+\]/.test(value);
  const parserAlternatives = /\[[A-Za-z][^\]|]*\|[\s\S]*[A-Za-z]/.test(value);
  const generic = genericTextContainers.has(context) || /^push\[\d+\]$/.test(context) || /^RandomInCollection\[\d+\]$/.test(context);
  if (generic) return parserAlternatives || words.length >= 3 || (parser && words.length >= 1) || (words.length >= 2 && html);
  if (context === 'o[0]' && words.length >= 4 && /^[A-Z]/.test(value.trim())) return true;
  if (/^[A-Za-z_$][\w$]*\[\d+\]$/.test(context)) return words.length >= 5 || (words.length >= 4 && rich) || (words.length >= 3 && html);
  return false;
}
export function extract(source, file) {
  const ast = parseJs(source), rows = [], stack = [], chains = [], taggedTemplateArrays = [];
  let dynamicTemplates = 0;
  function stringish(node) {
    return (node.type === 'Literal' && typeof node.value === 'string') ||
      (node.type === 'TemplateLiteral' && !node.expressions.length) ||
      (node.type === 'BinaryExpression' && node.operator === '+' && (stringish(node.left) || stringish(node.right))) ||
      (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && nameOf(node.callee.property) === 'concat' && stringish(node.callee.object));
  }
  function flatten(node) {
    if (node.type === 'Literal' && typeof node.value === 'string' || node.type === 'TemplateLiteral' && !node.expressions.length) return [{ node }];
    if (node.type === 'BinaryExpression' && node.operator === '+' && stringish(node)) return [...flatten(node.left), ...flatten(node.right)];
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && nameOf(node.callee.property) === 'concat' && stringish(node.callee.object)) return [...flatten(node.callee.object), ...node.arguments.flatMap(flatten)];
    return [{ expression: source.slice(node.start, node.end) }];
  }
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  function lineAt(offset) {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= offset) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ArrayExpression') {
      const parent = stack.at(-1);
      const taggedHelper = parent?.type === 'CallExpression' && parent.arguments[0] === node &&
        parent.callee.type === 'SequenceExpression' && nameOf(parent.callee) === 'Z';
      if (taggedHelper && node.elements.length > 1 && node.elements.every(element =>
        element?.type === 'Literal' && typeof element.value === 'string')) taggedTemplateArrays.push(node.elements);
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length) dynamicTemplates++;
    if ((node.type === 'BinaryExpression' || node.type === 'CallExpression') && stringish(node)) {
      chains.push(flatten(node));
    }
    const string = node.type === 'Literal' && typeof node.value === 'string';
    const template = node.type === 'TemplateLiteral' && node.expressions.length === 0;
    if (string || template) {
      const original = string ? node.value : node.quasis[0].value.cooked;
      let [category, context] = classify(node, stack);
      const lockedCode = forcedCodeContext(context) || asset(original) || standaloneInternalIdentifier(original) || cssClassList(original) || (['code', 'review'].includes(category) && looksLikeDiagnosticOrCode(original));
      if (!lockedCode && category === 'code' && !['property.key', 'object_key', 'MemberExpression', 'BinaryExpression'].includes(context) && hasWords(original) && original.length >= 30 && /\s/.test(original)) category = 'review';
      const technicalDiagnostic = isTechnicalDiagnostic(original);
      if (technicalDiagnostic || lockedCode) category = 'code';
      const promotedHtmlText = !technicalDiagnostic && !lockedCode && ['code', 'review'].includes(category) && visibleHtmlText(original);
      if (promotedHtmlText) category = 'ui_text';
      const promotedFromReview = !technicalDiagnostic && !lockedCode && category === 'review' && strongPlayerText(original, context);
      if (promotedFromReview) category = 'container_text';
      const shouldTranslate = !['code', 'review'].includes(category) && hasWords(original, context) && !asset(original);
      rows.push({ id: `${file}:${node.start}:${node.end}:${sha1(original).slice(0, 12)}`, file, category, context,
        shouldTranslate, shouldTranslated: shouldTranslate, original, translation: '',
        start: node.start, end: node.end, line: lineAt(node.start), raw: source.slice(node.start, node.end),
        ...(technicalDiagnostic ? { classificationReason: 'technical_diagnostic' } : lockedCode ? { classificationReason: 'protected_code_or_asset' } : {}),
        ...(promotedHtmlText ? { classificationReason: 'visible_html_text' } : {}),
        ...(promotedFromReview ? { classificationReason: 'confirmed_player_text_in_container' } : {}),
        ...(category === 'review' ? { needsReview: true } : {}) });
    }
    stack.push(node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) { for (const child of value) if (child && typeof child.type === 'string') visit(child); }
      else if (value && typeof value.type === 'string') visit(value);
    }
    stack.pop();
  }
  visit(ast);
  rows.sort((a, b) => a.start - b.start);
  // Group the top-level literal pieces of concatenations, including Babel's .concat(),
  // without evaluating dynamic expressions. Literals nested inside a conditional are
  // separate rows and may sit between these rows in source order.
  const rowIndex = new Map(rows.map((row, i) => [row.start, i]));
  let group = 0;
  for (const terms of chains) {
    const literals = terms.filter(t => t.node);
    if (literals.length < 2) continue;
    const indices = literals.map(t => rowIndex.get(t.node.start));
    if (indices.some(index => index === undefined) || new Set(indices).size !== indices.length) continue;
    if (indices.some((index, k) => k && index <= indices[k - 1])) continue;
    const unit = indices.map(index => rows[index]);
    if (unit.some(row => row.unitId || forcedCodeContext(row.context) || row.classificationReason === 'technical_diagnostic')) continue;
    if (!unit.some(row => row.shouldTranslate)) continue;
    const unitId = `${file}:unit:${++group}`;
    const category = unit.find(row => !['code', 'review'].includes(row.category))?.category || 'container_text';
    let literalIndex = -1, expressions = [];
    for (const term of terms) {
      if (!term.node) { expressions.push(term.expression); continue; }
      if (literalIndex >= 0) unit[literalIndex].joinAfter = { expression: expressions.join(' + '), token: `__E${literalIndex}__` };
      literalIndex++; expressions = [];
    }
    unit.forEach(row => {
      row.unitId = unitId;
      row.shouldTranslate = true;
      row.shouldTranslated = true;
      if (['code', 'review'].includes(row.category)) row.category = category;
      delete row.needsReview;
      delete row.reviewReason;
      if (!row.classificationReason) row.classificationReason = 'confirmed_player_text_in_concat';
    });
  }
  // Babel emits tagged template literals as (0, helper.Z)(["quasi 1", "quasi 2"])
  // and supplies the runtime expressions separately. Treat the quasis as one unit;
  // translating either half alone can expose an apparently unmatched game-parser token.
  for (const elements of taggedTemplateArrays) {
    const allQuasis = elements.map(element => rows[rowIndex.get(element.start)]);
    let substantiveLength = allQuasis.length;
    while (substantiveLength && !allQuasis[substantiveLength - 1]?.original.trim()) substantiveLength--;
    const unit = allQuasis.slice(0, substantiveLength);
    for (const row of allQuasis.slice(substantiveLength)) {
      if (!row) continue;
      row.category = 'code';
      row.context = 'tagged_template_quasi';
      row.shouldTranslate = false;
      row.shouldTranslated = false;
      row.classificationReason = 'whitespace_literal';
      row.exclusionReason = 'no_player_visible_text';
      delete row.unitId;
      delete row.joinAfter;
      delete row.needsReview;
      delete row.reviewReason;
    }
    if (!unit.length) continue;
    if (unit.some(row => !row || row.unitId)) continue;
    const aggregate = unit.map(row => row.original).join('');
    if (!unit.some(row => row.shouldTranslate) && !strongPlayerText(aggregate, 'ArrayExpression')) continue;
    const unitId = `${file}:unit:${++group}`;
    unit.forEach((row, index) => {
      row.category = row.category === 'dialogue' ? row.category : 'container_text';
      row.context = 'tagged_template_quasi';
      row.shouldTranslate = true;
      row.shouldTranslated = true;
      row.unitId = unitId;
      delete row.needsReview;
      delete row.reviewReason;
      if (index < unit.length - 1) row.joinAfter = { expression: `tagged_template_expression_${index}`, token: `__E${index}__` };
    });
  }
  // Standalone empty and whitespace-only literals carry no player-facing text.
  // Whitespace rows inside a grouped interpolation unit remain in that unit so
  // its byte-for-byte structure can be validated and applied atomically.
  for (const row of rows) if (!row.original.trim() && !row.unitId) {
    row.shouldTranslate = false;
    row.shouldTranslated = false;
    row.category = 'code';
    row.classificationReason = row.original === '' ? 'empty_literal' : 'whitespace_literal';
    row.exclusionReason = 'no_player_visible_text';
    delete row.unitId;
    delete row.joinAfter;
    delete row.needsReview;
    delete row.reviewReason;
  }
  // Never ask a model to translate the exposed half of an unresolved parser command.
  // Some are source typos; others close inside a runtime branch or a separate output call.
  // Both are deliberately excluded because static extraction cannot prove them safe.
  for (const unit of rowUnits(rows)) {
    if (!unit.some(r => r.shouldTranslate)) continue;
    const text = unit.map(r => r.original).join('');
    let depth = 0, broken = false;
    for (const ch of text) { if (ch === '[') depth++; else if (ch === ']' && --depth < 0) broken = true; }
    if (depth || broken) for (const row of unit) {
      row.shouldTranslate = false;
      row.shouldTranslated = false;
      row.category = 'code';
      row.classificationReason = 'unsafe_game_parser_syntax_or_dynamic_fragment';
      row.exclusionReason = 'unbalanced_game_parser_fragment';
      delete row.needsReview;
      delete row.reviewReason;
    }
  }
  const byCategory = {};
  for (const row of rows) byCategory[row.category] = (byCategory[row.category] || 0) + 1;
  return { schemaVersion: 1, file, sourceFile: path.join(APP, file), sourceSha1: sha1(source),
    total: rows.length, shouldTranslate: rows.filter(r => r.shouldTranslate).length, needsReview: rows.filter(r => r.needsReview).length,
    dynamicTemplates, byCategory, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = option('--input', '');
  const files = input ? [path.basename(input)] : fs.readdirSync(APP).filter(n => /^(content_.*|main\.[\da-f]+)\.js$/i.test(n)).sort();
  const index = { generatedAt: new Date().toISOString(), files: [] };
  for (const file of files) {
    const doc = extract(fs.readFileSync(path.join(APP, file), 'utf8'), file);
    const output = path.join(EXTRACTED, `${file}.json`);
    writeJson(output, doc);
    const { rows, ...summary } = doc;
    index.files.push(summary);
    console.log(`${file}: ${doc.shouldTranslate}/${doc.total} translatable; review=${doc.byCategory.review || 0}`);
  }
  writeJson(path.join(EXTRACTED, '_index.json'), index);
}
