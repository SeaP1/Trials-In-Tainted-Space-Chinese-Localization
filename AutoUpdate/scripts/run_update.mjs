import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { jsNames, readJson, sha1, writeJson } from './migration_common.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.dirname(scriptDir);
const argv = process.argv.slice(2);
const has = name => argv.includes(name);
const arg = (name, fallback = '') => has(name) ? argv[argv.indexOf(name) + 1] : fallback;

function requireDirectory(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${label} does not exist: ${dir}`);
}

function versionOf(root) {
  return readJson(path.join(root, 'resources', 'app', 'package.json')).version;
}

function runScript(name, args, env = {}) {
  console.log(`\n>>> ${name}`);
  const result = spawnSync(process.execPath, [path.join(scriptDir, name), ...args], {
    cwd: bundleRoot,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} exited with code ${result.status}`);
}

async function environmentCheck() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
  const prettierPackage = readJson(path.join(bundleRoot, 'node_modules', 'prettier', 'package.json'));
  const prettier = await import(pathToFileURL(path.join(bundleRoot, 'node_modules', 'prettier', 'index.mjs')));
  if (typeof prettier.format !== 'function') throw new Error('Bundled Prettier is invalid');
  console.log(JSON.stringify({ node: process.version, prettier: prettierPackage.version, bundleRoot }, null, 2));
  return prettier;
}

async function formatSources(newRoot, prettier) {
  const translatorRoot = path.join(newRoot, 'translator');
  const appRoot = path.join(newRoot, 'resources', 'app');
  const backupRoot = path.join(translatorRoot, 'backups', 'original_js');
  const reportPath = path.join(translatorRoot, 'reports', 'format_manifest.json');
  const existing = fs.existsSync(reportPath) ? readJson(reportPath) : null;
  const previousByName = new Map((existing?.files || []).map(file => [file.file, file]));
  const files = [];
  fs.mkdirSync(backupRoot, { recursive: true });

  for (const name of jsNames(appRoot)) {
    const sourcePath = path.join(appRoot, name);
    const backupPath = path.join(backupRoot, name);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const previous = previousByName.get(name);
    if (previous && sha1(source) === previous.formattedSha1) {
      files.push(previous);
      console.log(`Already formatted: ${name}`);
      continue;
    }
    if (previous && sha1(source) !== previous.originalSha1) {
      throw new Error(`${name}: source changed after a previous formatting pass; refusing to overwrite it`);
    }
    if (!fs.existsSync(backupPath)) fs.copyFileSync(sourcePath, backupPath);
    else if (sha1(fs.readFileSync(backupPath)) !== (previous?.originalSha1 || sha1(source))) {
      throw new Error(`${name}: existing original backup does not match`);
    }
    const formatted = await prettier.format(source, {
      parser: 'babel',
      endOfLine: 'lf',
      embeddedLanguageFormatting: 'off',
      printWidth: 80,
      tabWidth: 2,
      useTabs: false,
      semi: true,
      singleQuote: false,
      trailingComma: 'all',
      arrowParens: 'always',
    });
    fs.writeFileSync(sourcePath, formatted, 'utf8');
    files.push({ file: name, originalSha1: sha1(source), formattedSha1: sha1(formatted), backup: backupPath });
    console.log(`Formatted: ${name}`);
  }
  writeJson(reportPath, { prettier: readJson(path.join(bundleRoot, 'node_modules', 'prettier', 'package.json')).version, generatedAt: new Date().toISOString(), files });
}

function clearGeneratedJson(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name === '_index.json' || /^(?:content_.*|main\.[a-f0-9]+)\.js\.json$/i.test(name)) fs.rmSync(path.join(dir, name));
  }
}

const portableOldTranslatorFiles = [
  'launch_cn.ps1',
  'launch_cn_nosandbox.ps1',
];

const portableRootLaunchers = ['launch_cn.exe', 'launch_cn_nosandbox.exe'];

function installOneFile(sourcePath, destinationPath, report, transform = null) {
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Required translator tool is missing: ${sourcePath}`);
  }
  let data = fs.readFileSync(sourcePath);
  if (transform) data = Buffer.from(transform(data.toString('utf8')), 'utf8');
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (fs.existsSync(destinationPath)) {
    const existing = fs.readFileSync(destinationPath);
    if (sha1(existing) === sha1(data)) {
      report.unchanged.push(destinationPath);
      return;
    }
    if (!has('--overwrite-tools')) {
      report.preservedModified.push(destinationPath);
      return;
    }
  }
  fs.writeFileSync(destinationPath, data);
  report.installed.push(destinationPath);
}

function installDirectory(sourceDir, destinationDir, report) {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`Required translator tool directory is missing: ${sourceDir}`);
  }
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) installDirectory(sourcePath, destinationPath, report);
    else if (entry.isFile()) installOneFile(sourcePath, destinationPath, report);
  }
}

function verifyInstalledToolchain(translatorRoot) {
  const required = [
    'apply_translations_to_app.mjs',
    'pipeline.mjs',
  ];
  const checked = [];
  for (const name of required) {
    const file = path.join(translatorRoot, name);
    if (!fs.existsSync(file)) throw new Error(`Installed translator tool is missing: ${file}`);
    const result = spawnSync(process.execPath, ['--check', file], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${name} syntax check failed:\n${result.stderr || result.stdout}`);
    checked.push(name);
  }
  const applySource = fs.readFileSync(path.join(translatorRoot, 'apply_translations_to_app.mjs'), 'utf8');
  if (!applySource.includes('/^main\\.[\\da-f]+\\.js$/i.test(file)')) {
    throw new Error('Installed apply script still contains a version-specific main bundle check');
  }
  for (const name of ['glossary_en_zh.json', 'mapping_en_zh.json', 'mapping_struction_en_zh.json']) {
    if (!fs.existsSync(path.join(translatorRoot, 'glossary', name))) {
      throw new Error(`Installed translator glossary is incomplete: ${name} is missing`);
    }
  }
  if (!fs.existsSync(path.join(translatorRoot, 'node_modules', 'acorn', 'package.json'))) {
    throw new Error('Installed translator dependencies are incomplete: Acorn is missing');
  }
  return checked;
}

function installTranslatorToolchain(oldRoot, newRoot) {
  const oldTranslator = path.join(oldRoot, 'translator');
  const newTranslator = path.join(newRoot, 'translator');
  requireDirectory(oldTranslator, 'Old translator directory');
  const report = { installed: [], unchanged: [], preservedModified: [] };
  for (const name of portableOldTranslatorFiles) {
    installOneFile(
      path.join(oldTranslator, name),
      path.join(newTranslator, name),
      report,
    );
  }
  // The updater owns the version-independent apply/pipeline pair. Do not copy
  // an older game's bundle-specific runtime anchors into the new version.
  installOneFile(path.join(scriptDir, 'apply_translations_to_app.mjs'), path.join(newTranslator, 'apply_translations_to_app.mjs'), report);
  installOneFile(path.join(scriptDir, 'pipeline.mjs'), path.join(newTranslator, 'pipeline.mjs'), report);
  // Install the updater's metadata-free runtime copy. The old game's full
  // glossary remains the editable source and is never modified.
  installDirectory(path.join(bundleRoot, 'glossary'), path.join(newTranslator, 'glossary'), report);
  // Dependencies are bundled with the updater, so migration does not depend
  // on the old game having previously run npm install.
  installDirectory(
    path.join(bundleRoot, 'node_modules', 'acorn'),
    path.join(newTranslator, 'node_modules', 'acorn'),
    report,
  );
  for (const name of portableRootLaunchers) {
    installOneFile(path.join(oldRoot, name), path.join(newRoot, name), report);
  }
  const syntaxChecked = verifyInstalledToolchain(newTranslator);
  const manifest = {
    generatedAt: new Date().toISOString(),
    oldRoot,
    newRoot,
    installed: report.installed.map(file => path.relative(newRoot, file)),
    unchanged: report.unchanged.map(file => path.relative(newRoot, file)),
    preservedModified: report.preservedModified.map(file => path.relative(newRoot, file)),
    syntaxChecked,
  };
  writeJson(path.join(newTranslator, 'reports', 'toolchain_manifest.json'), manifest);
  console.log(`Translator toolchain ready: ${manifest.installed.length} installed, ${manifest.unchanged.length} unchanged, ${manifest.preservedModified.length} preserved.`);
  return manifest;
}

try {
  const prettier = await environmentCheck();
  if (has('--check')) process.exit(0);

  const oldRoot = fs.realpathSync(path.resolve(arg('--old')));
  const newRoot = fs.realpathSync(path.resolve(arg('--new')));
  requireDirectory(path.join(oldRoot, 'resources', 'app'), 'Old game app directory');
  requireDirectory(path.join(newRoot, 'resources', 'app'), 'New game app directory');
  if (oldRoot.toLowerCase() === newRoot.toLowerCase()) throw new Error('Old and new game directories must differ');

  const baselineDir = path.join(oldRoot, 'translator', 'translated_json');
  requireDirectory(baselineDir, 'Old game translated_json directory');
  if (!fs.readdirSync(baselineDir).some(name => name.endsWith('.js.json'))) {
    throw new Error(`Old game translated_json contains no translation JSON: ${baselineDir}`);
  }
  const oldVersion = versionOf(oldRoot), newVersion = versionOf(newRoot);
  const overridePath = path.join(bundleRoot, 'manual_migration_overrides.json');
  const manualOverrideArgs = fs.existsSync(overridePath)
    ? ['--manual-overrides', overridePath]
    : [];
  console.log(`Migrating TiTS ${oldVersion} -> ${newVersion}`);

  const toolchain = installTranslatorToolchain(oldRoot, newRoot);
  if (has('--install-tools-only')) {
    console.log(`Translator toolchain installation completed. Manifest: ${path.join(newRoot, 'translator', 'reports', 'toolchain_manifest.json')}`);
    process.exit(0);
  }

  const translatorRoot = path.join(newRoot, 'translator');
  const extractedDir = path.join(translatorRoot, 'extracted_json');
  const translatedDir = path.join(translatorRoot, 'translated_json');
  if (fs.existsSync(translatedDir) && fs.readdirSync(translatedDir).some(name => name.endsWith('.js.json')) && !has('--resume')) {
    throw new Error('The new game already has translated_json data. Use --resume only to deliberately regenerate this migration.');
  }
  fs.mkdirSync(path.join(translatorRoot, 'reports'), { recursive: true });
  await formatSources(newRoot, prettier);
  clearGeneratedJson(extractedDir);
  if (has('--resume')) clearGeneratedJson(translatedDir);

  runScript('extract_text.mjs', [], {
    TITS_GAME_ROOT: newRoot,
    TITS_TRANSLATOR_ROOT: translatorRoot,
  });
  runScript('migrate_translations.mjs', [
    '--old-root', oldRoot,
    '--new-root', newRoot,
    '--baseline-dir', baselineDir,
    ...manualOverrideArgs,
    ...(has('--resume') ? ['--overwrite'] : []),
  ]);
  runScript('verify_migration.mjs', ['--new-root', newRoot, '--baseline-dir', baselineDir]);
  console.log(`\nMigration completed. Reports: ${path.join(translatorRoot, 'reports')}`);
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
