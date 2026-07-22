const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { exec } = require('child_process');

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const THREAD_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BACKUP_DIR_RE = /^backup-\d{8}-\d{6}-.+/;
const AUTH_SNAPSHOT_REASON = 'manual-auth-snapshot';
const HISTORY_TRANSFER_FORMAT = 'codex-history-transfer';
const HISTORY_TRANSFER_VERSION = 1;
const HISTORY_TRANSFER_EXTENSION = '.codex-history';
const HISTORY_TRANSFER_MAX_BYTES = 128 * 1024 * 1024;
const HISTORY_TRANSFER_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const HISTORY_TRANSFER_STAGING_PREFIX = '.history-import-staging-';
const FILE_MUTATION_JOURNAL_PREFIX = '.history-mutation-journal-';
const API_BODY_MAX_BYTES = 1024 * 1024;
const API_COOKIE_NAME = 'history_recovery_token';
const SQLITE_STATE_FILE_NAMES = new Set(['state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm']);
const PROJECT_BACKUP_REASONS = new Set([
  'pre-chat-history-restore',
  'pre-backup-restore',
  'pre-settings-rollback',
  'pre-backup-content-apply',
  'pre-chat-history-import',
  AUTH_SNAPSHOT_REASON,
]);
const STATE_FILE_NAMES = ['state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm', 'session_index.jsonl', '.codex-global-state.json', 'config.toml', 'config.toml.bak', 'auth.json', 'auth.json.bak'];
const RESTORABLE_DIR_NAMES = ['sessions', 'archived_sessions'];

function stripExtendedPrefix(value) {
  return value && value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

function validateRoot(root) {
  if (!root || !fs.existsSync(root)) throw new Error(`Missing Codex root: ${root || '(empty)'}`);
  const db = path.join(root, 'state_5.sqlite');
  if (!fs.existsSync(db)) throw new Error(`Missing state_5.sqlite: ${db}`);
  return db;
}

function openDatabase(dbPath, readonly) {
  const db = new DatabaseSync(dbPath, { readOnly: readonly });
  db.exec('PRAGMA busy_timeout = 10000;');
  return db;
}

function withDatabase(root, readonly, fn) {
  const dbPath = validateRoot(root);
  const db = openDatabase(dbPath, readonly);
  try {
    return fn(db, dbPath);
  } finally {
    db.close();
  }
}

function queryRows(db, sql) {
  return db.prepare(sql).all();
}

function runImmediateTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  }
}

function checkpoint(db) {
  db.exec('PRAGMA wal_checkpoint(PASSIVE);');
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sourceList(includeSubagents) {
  return (includeSubagents ? ['user', 'subagent'] : ['user']).map(sqlQuote).join(',');
}

function providerList(oldProviders) {
  if (!oldProviders || oldProviders.length === 0) return "''";
  return oldProviders.map(sqlQuote).join(',');
}

function getCandidateRows(db, includeSubagents, oldProviders) {
  return queryRows(db, `
select id, model_provider, thread_source, archived, cwd
from threads
where thread_source in (${sourceList(includeSubagents)})
  and (
    model_provider is null
    or model_provider = ''
    or model_provider in (${providerList(oldProviders)})
  )
order by updated_at desc;
`);
}

function walkFiles(root, predicate, list = []) {
  if (!fs.existsSync(root)) return list;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, list);
    else if (!predicate || predicate(full, entry)) list.push(full);
  }
  return list;
}

function firstJsonLine(file, maxBytes = 1024 * 1024) {
  const stat = fs.statSync(file);
  const readLength = Math.min(stat.size, maxBytes + 1);
  const buffer = Buffer.alloc(readLength);
  const fd = fs.openSync(file, 'r');
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buffer, 0, readLength, 0);
  } finally {
    fs.closeSync(fd);
  }
  const newline = buffer.indexOf(0x0a, 0);
  if (newline < 0 && stat.size > maxBytes) throw new Error('JSONL metadata line is too large.');
  const end = newline >= 0 ? newline : bytesRead;
  const first = buffer.subarray(0, end).toString('utf8').replace(/\r$/, '').replace(/^\uFEFF/, '');
  return first ? JSON.parse(first) : null;
}

function readTextIfExists(file) {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safeHashFile(file) {
  try {
    return fs.existsSync(file) ? hashFile(file) : '';
  } catch {
    return '';
  }
}

function collectAuthSignals(value, signals = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return signals;
  for (const [key, child] of Object.entries(value)) {
    const lower = String(key).toLowerCase();
    if (lower === 'openai_api_key') signals.add('api_key');
    if (lower === 'auth_mode') signals.add('auth_mode');
    if (lower.includes('oauth')) signals.add('oauth');
    if (lower.includes('account') || lower === 'email' || lower === 'user') signals.add('account');
    if (lower.includes('refresh') || lower.includes('access_token') || lower === 'id_token' || lower === 'tokens') signals.add('oauth_token');
    collectAuthSignals(child, signals, depth + 1);
  }
  return signals;
}

function readAuthSummaryFromPath(authPath) {
  const summary = {
    path: authPath,
    exists: fs.existsSync(authPath),
    readable: false,
    size: 0,
    modifiedAt: '',
    authMode: '',
    hasApiKey: false,
    likelyAccountAuth: false,
    authType: 'missing',
    signals: [],
    error: '',
  };
  if (!summary.exists) return summary;
  try {
    const stat = fs.statSync(authPath);
    summary.size = stat.size;
    summary.modifiedAt = stat.mtime.toISOString();
  } catch {}
  try {
    const text = fs.readFileSync(authPath, 'utf8').replace(/^\uFEFF/, '');
    const auth = text.trim() ? JSON.parse(text) : {};
    const signals = collectAuthSignals(auth);
    const mode = String(auth.auth_mode || auth.authMode || auth.mode || '').trim();
    const lowerMode = mode.toLowerCase();
    const apiKey = String(auth.OPENAI_API_KEY || auth.openai_api_key || '').trim();
    summary.readable = true;
    summary.authMode = mode;
    summary.hasApiKey = Boolean(apiKey) || signals.has('api_key') || lowerMode === 'apikey';
    summary.likelyAccountAuth = !summary.hasApiKey && (
      /oauth|account|chatgpt|login|browser/i.test(mode)
      || signals.has('oauth')
      || signals.has('oauth_token')
      || signals.has('account')
    );
    summary.authType = summary.hasApiKey ? 'api_key' : summary.likelyAccountAuth ? 'account' : 'unknown';
    summary.signals = [...signals].sort();
    return summary;
  } catch (error) {
    summary.authType = 'unreadable';
    summary.error = error.message;
    return summary;
  }
}

function readAuthSummary(root) {
  return readAuthSummaryFromPath(path.join(root, 'auth.json'));
}

function readConfigModelProvider(root) {
  const text = readTextIfExists(path.join(root, 'config.toml'));
  if (!text.trim()) return '';
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine)) continue;
    if (/^\s*\[/.test(rawLine)) break;
    const line = rawLine.replace(/#.*/, '').trim();
    const match = line.match(/^model_provider\s*=\s*(['"])(.*?)\1\s*$/);
    if (match && match[2].trim()) return match[2].trim();
  }
  return '';
}

function updateConfigModelProvider(root, targetProvider) {
  const provider = String(targetProvider || '').trim();
  if (!provider) throw new Error('Target Provider is required to update config.toml.');
  const configPath = path.join(root, 'config.toml');
  const previous = readConfigModelProvider(root);
  const text = readTextIfExists(configPath);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const nextLine = `model_provider = ${JSON.stringify(provider)}`;
  let output = '';
  if (!text) {
    output = `${nextLine}${eol}`;
  } else {
    const lines = text.split(/\r?\n/);
    let replaced = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*#/.test(lines[i])) continue;
      if (/^\s*\[/.test(lines[i])) break;
      if (/^\s*model_provider\s*=/.test(lines[i])) {
        lines[i] = nextLine;
        replaced = true;
        break;
      }
    }
    if (replaced) {
      output = lines.join(eol);
    } else {
      const tableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
      if (tableIndex >= 0) {
        const insertAt = tableIndex > 0 && lines[tableIndex - 1].trim() === '' ? tableIndex - 1 : tableIndex;
        lines.splice(insertAt, 0, nextLine, '');
        output = lines.join(eol);
      } else {
        output = `${text}${/\r?\n$/.test(text) ? '' : eol}${nextLine}${eol}`;
      }
    }
  }
  if (output !== text) fs.writeFileSync(configPath, output, 'utf8');
  return { path: configPath, previous, current: provider, changed: output !== text };
}

function removeConfigModelProvider(root) {
  const configPath = path.join(root, 'config.toml');
  const previous = readConfigModelProvider(root);
  const text = readTextIfExists(configPath);
  if (!text) return { path: configPath, previous, current: '', changed: false };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let removed = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*#/.test(lines[i])) continue;
    if (/^\s*\[/.test(lines[i])) break;
    if (/^\s*model_provider\s*=/.test(lines[i])) {
      lines.splice(i, 1);
      removed = true;
      break;
    }
  }
  const output = lines.join(eol);
  if (removed && output !== text) fs.writeFileSync(configPath, output, 'utf8');
  return { path: configPath, previous, current: '', changed: removed && output !== text };
}

function resolveThreadId(meta, file) {
  let id = meta?.payload?.id ? String(meta.payload.id) : '';
  if (!id) {
    const match = path.basename(file).match(THREAD_ID_RE);
    if (match) id = match[0];
  }
  return id;
}

function getJsonlPlan(root, candidateRows) {
  const candidateIds = new Set(candidateRows.map((row) => String(row.id)));
  const plan = { toChange: 0, locked: 0, bad: 0 };
  for (const dir of [path.join(root, 'sessions'), path.join(root, 'archived_sessions')]) {
    for (const file of walkFiles(dir, (full) => path.basename(full).startsWith('rollout-') && full.endsWith('.jsonl'))) {
      try {
        const meta = firstJsonLine(file);
        if (!meta || meta.type !== 'session_meta' || !meta.payload) continue;
        if (candidateIds.has(resolveThreadId(meta, file))) plan.toChange += 1;
      } catch (error) {
        if (/being used|cannot access|EBUSY|EPERM/i.test(error.message)) plan.locked += 1;
        else plan.bad += 1;
      }
    }
  }
  return plan;
}

function copyFileSafe(src, dest, skipped) {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  } catch (error) {
    skipped.push({ path: src, reason: error.message });
  }
}

class FileMutationJournal {
  constructor(root) {
    this.root = path.resolve(root);
    this.directory = '';
    this.entries = [];
    this.captured = new Set();
  }

  ensureDirectory() {
    if (!this.directory) {
      this.directory = path.join(this.root, FILE_MUTATION_JOURNAL_PREFIX + crypto.randomUUID());
      fs.mkdirSync(this.directory, { recursive: false });
    }
    return this.directory;
  }

  capture(file) {
    const resolved = path.resolve(file);
    if (this.captured.has(resolved)) return;
    const exists = fs.existsSync(resolved);
    let snapshot = '';
    if (exists) {
      snapshot = path.join(this.ensureDirectory(), `${this.entries.length}.bin`);
      fs.copyFileSync(resolved, snapshot);
    }
    this.entries.push({ path: resolved, exists, snapshot });
    this.captured.add(resolved);
  }

  write(file, content, options = undefined) {
    const resolved = path.resolve(file);
    this.capture(resolved);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, options);
  }

  rollback() {
    const errors = [];
    for (const entry of [...this.entries].reverse()) {
      try {
        if (entry.exists) {
          fs.mkdirSync(path.dirname(entry.path), { recursive: true });
          fs.copyFileSync(entry.snapshot, entry.path);
        } else {
          fs.rmSync(entry.path, { force: true });
        }
      } catch (error) {
        errors.push(`${entry.path}: ${error.message}`);
      }
    }
    return errors;
  }

  dispose() {
    if (!this.directory || !isInside(this.root, this.directory) || !path.basename(this.directory).startsWith(FILE_MUTATION_JOURNAL_PREFIX)) return;
    try { fs.rmSync(this.directory, { recursive: true, force: true }); } catch {}
    this.directory = '';
  }
}

function appendRollbackErrors(error, errors, label = 'File rollback') {
  if (errors.length) error.message += ` ${label} also failed: ${errors.join('; ')}`;
}

function runCoordinatedMutation(root, mutate) {
  const dbPath = validateRoot(root);
  const db = openDatabase(dbPath, false);
  const journal = new FileMutationJournal(root);
  let committed = false;
  let began = false;
  let result;
  let operationError = null;
  try {
    db.exec('BEGIN IMMEDIATE;');
    began = true;
    result = mutate(db, journal);
    db.exec('COMMIT;');
    committed = true;
  } catch (error) {
    operationError = error;
    if (began && !committed) {
      try { db.exec('ROLLBACK;'); } catch (rollbackError) { error.message += ` Database rollback also failed: ${rollbackError.message}`; }
    }
    appendRollbackErrors(error, journal.rollback());
  }

  if (committed) {
    try { checkpoint(db); } catch (error) { result.checkpointWarning = error.message; }
  }
  try {
    db.close();
  } catch (error) {
    if (!operationError && !committed) operationError = error;
    else if (result) result.closeWarning = error.message;
  }
  journal.dispose();
  if (operationError) throw operationError;
  return result;
}

function createSqliteSnapshot(source, destination) {
  const db = openDatabase(source, true);
  try {
    db.exec(`VACUUM INTO ${sqlQuote(destination)};`);
  } finally {
    db.close();
  }
  const snapshot = openDatabase(destination, true);
  try {
    const result = snapshot.prepare('PRAGMA quick_check;').get();
    if (!result || String(result.quick_check || '').toLowerCase() !== 'ok') {
      throw new Error('SQLite safety snapshot failed its integrity check.');
    }
  } finally {
    snapshot.close();
  }
}

function backupStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function createUniqueBackupPath(root, reason) {
  const base = path.join(root, `backup-${backupStamp()}-${reason}`);
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to create a unique backup directory for ${reason}.`);
}

function createCodexStateBackup(root, { targetProvider = '', oldProviders = [], includeSubagents = false, reason = 'pre-chat-history-restore', requireComplete = true } = {}) {
  const backup = createUniqueBackupPath(root, reason);
  const skipped = [];
  fs.mkdirSync(path.join(backup, 'files'), { recursive: true });
  try {
    const stateDb = path.join(root, 'state_5.sqlite');
    if (fs.existsSync(stateDb)) createSqliteSnapshot(stateDb, path.join(backup, 'state_5.sqlite'));
    for (const name of STATE_FILE_NAMES) {
      if (SQLITE_STATE_FILE_NAMES.has(name)) continue;
      const src = path.join(root, name);
      if (fs.existsSync(src)) copyFileSafe(src, path.join(backup, name), skipped);
    }
    for (const dirName of RESTORABLE_DIR_NAMES) {
      const srcDir = path.join(root, dirName);
      if (!fs.existsSync(srcDir)) continue;
      for (const src of walkFiles(srcDir)) {
        copyFileSafe(src, path.join(backup, 'files', dirName, path.relative(srcDir, src)), skipped);
      }
    }
    if (requireComplete && skipped.length) {
      throw new Error(`Safety backup is incomplete; ${skipped.length} file(s) could not be copied. Close Codex and try again.`);
    }
    fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({
      createdAt: new Date().toISOString(),
      reason,
      root,
      targetProvider,
      oldProviders,
      includeSubagents,
      skipped,
    }, null, 2), 'utf8');
    return { backup, skipped };
  } catch (error) {
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function normalizeAuthDisplayName(value, fallback = '') {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (name || fallback).slice(0, 80);
}

function createAuthSnapshot({ root, authDisplayName = '' }) {
  if (!root || !fs.existsSync(root)) throw new Error(`Missing Codex root: ${root || '(empty)'}`);
  const src = path.join(root, 'auth.json');
  if (!fs.existsSync(src)) throw new Error(`Missing auth.json: ${src}`);

  const backup = createUniqueBackupPath(root, AUTH_SNAPSHOT_REASON);
  const skipped = [];
  fs.mkdirSync(backup, { recursive: true });
  copyFileSafe(src, path.join(backup, 'auth.json'), skipped);
  const bak = path.join(root, 'auth.json.bak');
  if (fs.existsSync(bak)) copyFileSafe(bak, path.join(backup, 'auth.json.bak'), skipped);
  const snapshotAuthPath = path.join(backup, 'auth.json');
  if (!fs.existsSync(snapshotAuthPath)) {
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
    throw new Error('Could not save auth.json snapshot.');
  }

  const auth = readAuthSummaryFromPath(snapshotAuthPath);
  const authHash = safeHashFile(snapshotAuthPath);
  const displayName = normalizeAuthDisplayName(authDisplayName, path.basename(backup));
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    reason: AUTH_SNAPSHOT_REASON,
    root,
    scope: 'auth-json-only',
    authHash,
    authSize: auth.size,
    authModifiedAt: auth.modifiedAt,
    authDisplayName: displayName,
    skipped,
  }, null, 2), 'utf8');

  const cleanup = cleanupDuplicateAuthSnapshots({ root, yes: true, preferredPath: backup });
  return { root, backup, skipped, auth, authHash, authDisplayName: displayName, cleanup };
}

function backupCodexState(root, targetProvider, oldProviders, includeSubagents) {
  return createCodexStateBackup(root, { targetProvider, oldProviders, includeSubagents });
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readBackupManifest(backupPath) {
  const manifestPath = path.join(backupPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return {};
  const text = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
  return text.trim() ? JSON.parse(text) : {};
}

function isProjectBackupManifest(manifest) {
  return PROJECT_BACKUP_REASONS.has(String(manifest.reason || ''));
}

function listBackups({ root }) {
  if (!root || !fs.existsSync(root)) throw new Error(`Missing Codex root: ${root || '(empty)'}`);
  const backups = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && BACKUP_DIR_RE.test(entry.name))
    .map((entry) => {
      const backupPath = path.join(root, entry.name);
      let manifest = {};
      try { manifest = readBackupManifest(backupPath); } catch {}
      if (!isProjectBackupManifest(manifest)) return null;
      const stat = fs.statSync(backupPath);
      const authPath = path.join(backupPath, 'auth.json');
      const auth = readAuthSummaryFromPath(authPath);
      const authDisplayName = normalizeAuthDisplayName(manifest.authDisplayName, entry.name);
      return {
        name: entry.name,
        path: backupPath,
        createdAt: manifest.createdAt || stat.mtime.toISOString(),
        reason: manifest.reason || '',
        targetProvider: manifest.targetProvider || '',
        configModelProvider: readConfigModelProvider(backupPath),
        includeSubagents: Boolean(manifest.includeSubagents),
        hasAuthJson: auth.exists,
        hasStateDb: fs.existsSync(path.join(backupPath, 'state_5.sqlite')),
        authSnapshot: String(manifest.reason || '') === AUTH_SNAPSHOT_REASON,
        authHash: manifest.authHash || safeHashFile(authPath),
        authDisplayName,
        authSize: auth.size,
        authModifiedAt: auth.modifiedAt,
        auth,
        projectBackup: true,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { root, backups };
}

function resolveBackup(root, backupPath) {
  if (!backupPath || !String(backupPath).trim()) throw new Error('Backup path is required.');
  const rootPath = path.resolve(root);
  const resolved = path.resolve(path.isAbsolute(backupPath) ? backupPath : path.join(rootPath, backupPath));
  if (!isInside(rootPath, resolved)) throw new Error('Backup path must be inside the selected Codex root.');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Backup directory not found: ${resolved}`);
  const manifest = readBackupManifest(resolved);
  if (!BACKUP_DIR_RE.test(path.basename(resolved)) || !isProjectBackupManifest(manifest)) throw new Error('Selected folder was not created by this recovery tool.');
  return { path: resolved, manifest };
}

function readBackupContent({ root, backupPath }) {
  if (!root || !fs.existsSync(root)) throw new Error(`Missing Codex root: ${root || '(empty)'}`);
  const backup = resolveBackup(root, backupPath);
  const configPath = path.join(backup.path, 'config.toml');
  const authPath = path.join(backup.path, 'auth.json');
  const auth = readAuthSummaryFromPath(authPath);
  return {
    backup: backup.path,
    name: path.basename(backup.path),
    reason: String(backup.manifest.reason || ''),
    config: {
      exists: fs.existsSync(configPath),
      modelProvider: readConfigModelProvider(backup.path),
    },
    auth: {
      exists: auth.exists,
      content: readTextIfExists(authPath),
      summary: auth,
    },
  };
}

function normalizeAuthJson(content) {
  const text = String(content || '').replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('auth.json content cannot be empty.');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`auth.json is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('auth.json must contain a JSON object.');
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function renameBackupAuth({ root, backupPath, authDisplayName }) {
  if (!root || !fs.existsSync(root)) throw new Error(`Missing Codex root: ${root || '(empty)'}`);
  const backup = resolveBackup(root, backupPath);
  if (!fs.existsSync(path.join(backup.path, 'auth.json'))) throw new Error('Selected backup does not contain auth.json.');
  const displayName = normalizeAuthDisplayName(authDisplayName);
  if (!displayName) throw new Error('auth.json display name cannot be empty.');
  const authHash = safeHashFile(path.join(backup.path, 'auth.json'));
  const matching = listBackups({ root }).backups.filter((item) => authHash && item.authHash === authHash);
  const targets = matching.length ? matching.map((item) => item.path) : [backup.path];
  const updates = targets.map((target) => {
    const targetBackup = resolveBackup(root, target);
    const manifestPath = path.join(targetBackup.path, 'manifest.json');
    const previous = fs.readFileSync(manifestPath, 'utf8');
    const manifest = { ...targetBackup.manifest, authDisplayName: displayName };
    return { manifestPath, previous, next: JSON.stringify(manifest, null, 2) };
  });
  for (const update of updates) {
    const fd = fs.openSync(update.manifestPath, 'r+');
    fs.closeSync(fd);
  }
  const written = [];
  try {
    for (const update of updates) {
      fs.writeFileSync(update.manifestPath, update.next, 'utf8');
      written.push(update);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const update of written.reverse()) {
      try { fs.writeFileSync(update.manifestPath, update.previous, 'utf8'); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    if (rollbackErrors.length) error.message += ` Manifest rollback also failed: ${rollbackErrors.join('; ')}`;
    throw error;
  }
  return { backup: backup.path, authHash, authDisplayName: displayName, updated: targets.length };
}

function applyBackupContent({ root, authBackupPath = '', applyConfig = false, configProvider = '', applyAuth = false, authJson = '' }) {
  if (!root || !fs.existsSync(root)) throw new Error(`Missing Codex root: ${root || '(empty)'}`);
  if (!applyConfig && !applyAuth) throw new Error('Select config.toml, auth.json, or both before applying.');

  const authBackup = applyAuth ? resolveBackup(root, authBackupPath) : null;
  if (authBackup && !fs.existsSync(path.join(authBackup.path, 'auth.json'))) {
    throw new Error('Selected auth version does not contain auth.json.');
  }

  const normalizedAuth = applyAuth ? normalizeAuthJson(authJson) : '';
  const safety = createCodexStateBackup(root, { reason: 'pre-backup-content-apply', includeSubagents: true });
  const result = {
    authBackup: authBackup?.path || '',
    safetyBackup: safety.backup,
    config: null,
    auth: null,
  };
  const journal = new FileMutationJournal(root);
  try {
    if (applyConfig) {
      const configPath = path.join(root, 'config.toml');
      journal.capture(configPath);
      const provider = String(configProvider || '').trim();
      result.config = provider
        ? updateConfigModelProvider(root, provider)
        : removeConfigModelProvider(root);
    }

    if (applyAuth) {
      const authPath = path.join(root, 'auth.json');
      const previous = readAuthSummary(root);
      journal.write(authPath, normalizedAuth, 'utf8');
      result.auth = {
        path: authPath,
        previous,
        current: readAuthSummary(root),
        changed: true,
      };
    }
  } catch (error) {
    appendRollbackErrors(error, journal.rollback());
    journal.dispose();
    throw error;
  }
  journal.dispose();

  return result;
}

function copyRestoredFile(src, dest, restored, skipped) {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    restored.push(dest);
  } catch (error) {
    skipped.push({ path: dest, reason: error.message });
  }
}

function getThreadColumns(db) {
  return new Set(queryRows(db, 'pragma table_info(threads);').map((row) => String(row.name)));
}

function readThreadSettings(db) {
  const columns = getThreadColumns(db);
  const fields = ['model_provider', 'thread_source', 'archived'].filter((name) => columns.has(name));
  if (!columns.has('id')) throw new Error('threads table does not contain id column.');
  const selectFields = ['id', ...fields].join(', ');
  return {
    fields,
    rows: queryRows(db, `select ${selectFields} from threads where id is not null and id <> '';`),
  };
}

function normalizeDbValue(value) {
  return value === undefined ? null : value;
}

function restoreThreadSettingsFromBackup(currentDb, backupDb, { transactional = true } = {}) {
  const current = readThreadSettings(currentDb);
  const backup = readThreadSettings(backupDb);
  const fields = backup.fields.filter((field) => current.fields.includes(field));
  if (!fields.length) return { matched: 0, changed: 0, fields, missing: backup.rows.length };

  const currentById = new Map(current.rows.map((row) => [String(row.id), row]));
  const update = currentDb.prepare(`update threads set ${fields.map((field) => `${field}=?`).join(', ')} where id=?;`);
  let matched = 0;
  let changed = 0;
  let missing = 0;

  const apply = () => {
    for (const source of backup.rows) {
      const id = String(source.id);
      const target = currentById.get(id);
      if (!target) {
        missing += 1;
        continue;
      }
      matched += 1;
      const differs = fields.some((field) => normalizeDbValue(target[field]) !== normalizeDbValue(source[field]));
      if (!differs) continue;
      update.run(...fields.map((field) => normalizeDbValue(source[field])), id);
      changed += 1;
    }
  };
  if (transactional) runImmediateTransaction(currentDb, apply);
  else apply();

  return { matched, changed, fields, missing };
}

function updateJsonlProvidersFromBackup(root, backupDb, { journal = null, strict = false } = {}) {
  const backupSettings = readThreadSettings(backupDb);
  if (!backupSettings.fields.includes('model_provider')) {
    return { matched: 0, changed: [], skipped: [{ path: 'threads.model_provider', reason: 'Backup threads table does not contain model_provider column.' }] };
  }
  const providerById = new Map();
  for (const row of backupSettings.rows) {
    providerById.set(String(row.id), normalizeDbValue(row.model_provider));
  }

  const changed = [];
  const skipped = [];
  let matched = 0;

  for (const dir of [path.join(root, 'sessions'), path.join(root, 'archived_sessions')]) {
    for (const file of walkFiles(dir, (full) => path.basename(full).startsWith('rollout-') && full.endsWith('.jsonl'))) {
      try {
        const text = fs.readFileSync(file, 'utf8');
        const hadFinalNewline = /\r?\n$/.test(text);
        const lines = text.split(/\r?\n/);
        if (!lines[0]) continue;
        const meta = JSON.parse(lines[0].replace(/^\uFEFF/, ''));
        if (meta.type !== 'session_meta' || !meta.payload) continue;
        const id = resolveThreadId(meta, file);
        if (!providerById.has(id)) continue;
        matched += 1;
        const nextProvider = providerById.get(id);
        if (normalizeDbValue(meta.payload.model_provider) === nextProvider) continue;
        meta.payload.model_provider = nextProvider;
        lines[0] = JSON.stringify(meta);
        let output = lines.join('\n');
        if (hadFinalNewline && !output.endsWith('\n')) output += '\n';
        if (journal) journal.write(file, output, 'utf8');
        else fs.writeFileSync(file, output, 'utf8');
        changed.push(file);
      } catch (error) {
        if (strict) throw error;
        skipped.push({ path: file, reason: error.message });
      }
    }
  }

  return { matched, changed, skipped };
}

function restoreConfigProviderFromBackup(root, backupRoot) {
  const backupConfigPath = path.join(backupRoot, 'config.toml');
  if (!fs.existsSync(backupConfigPath)) {
    return { path: path.join(root, 'config.toml'), previous: readConfigModelProvider(root), current: readConfigModelProvider(root), changed: false, skipped: 'Backup does not contain config.toml.' };
  }
  const backupProvider = readConfigModelProvider(backupRoot);
  if (backupProvider) return updateConfigModelProvider(root, backupProvider);
  return removeConfigModelProvider(root);
}

function restoreSettingsFromBackup({ root, backupPath }) {
  if (!root || !fs.existsSync(root)) throw new Error(`Missing Codex root: ${root || '(empty)'}`);
  const backup = resolveBackup(root, backupPath);
  const backupDbPath = path.join(backup.path, 'state_5.sqlite');
  if (!fs.existsSync(backupDbPath)) throw new Error('Selected backup does not contain state_5.sqlite.');
  const safety = createCodexStateBackup(root, { reason: 'pre-settings-rollback', includeSubagents: true });
  const backupDb = openDatabase(backupDbPath, true);
  try {
    return runCoordinatedMutation(root, (db, journal) => {
      const threads = restoreThreadSettingsFromBackup(db, backupDb, { transactional: false });
      const jsonl = updateJsonlProvidersFromBackup(root, backupDb, { journal, strict: true });
      journal.capture(path.join(root, 'session_index.jsonl'));
      const indexLines = rebuildSessionIndex(db, root);
      journal.capture(path.join(root, '.codex-global-state.json'));
      const workspaceHintsAdded = updateWorkspaceHints(db, root);
      journal.capture(path.join(root, 'config.toml'));
      const config = restoreConfigProviderFromBackup(root, backup.path);
      const verify = verifyRestore(db, root);
      if (!isSuccessfulVerification(verify)) throw new Error('Settings rollback verification failed; all changes were reverted.');
      return {
        backup: backup.path,
        safetyBackup: safety.backup,
        mode: 'settings-only',
        threads,
        jsonlMatched: jsonl.matched,
        jsonlChanged: jsonl.changed.length,
        jsonlSkipped: jsonl.skipped,
        indexLines,
        workspaceHintsAdded,
        config,
        verify,
        passed: true,
      };
    });
  } finally {
    backupDb.close();
  }
}

function deleteBackup({ root, backupPath }) {
  if (!root || !fs.existsSync(root)) throw new Error(`Missing Codex root: ${root || '(empty)'}`);
  const backup = resolveBackup(root, backupPath);
  const name = path.basename(backup.path);
  if (!BACKUP_DIR_RE.test(name)) throw new Error('Refusing to delete a folder that is not a recovery backup.');
  fs.rmSync(backup.path, { recursive: true, force: false });
  return { root, deleted: backup.path, name };
}

function normalizeKeepCount(value) {
  const keep = Number(value ?? 2);
  if (!Number.isInteger(keep) || keep < 0) throw new Error('Keep count must be a non-negative integer.');
  return keep;
}

function cleanupExpiredBackups({ root, keep, yes = false }) {
  const keepCount = normalizeKeepCount(keep);
  const backups = listBackups({ root }).backups;
  const kept = backups.slice(0, keepCount);
  const expired = backups.slice(keepCount);
  const deleted = [];
  if (yes) {
    for (const item of expired) {
      const backup = resolveBackup(root, item.path);
      fs.rmSync(backup.path, { recursive: true, force: false });
      deleted.push(backup.path);
    }
  }
  return {
    root,
    keep: keepCount,
    total: backups.length,
    expiredCount: expired.length,
    kept,
    expired: yes ? [] : expired,
    deleted,
    dryRun: !yes,
  };
}

function cleanupDuplicateAuthSnapshots({ root, yes = false, preferredPath = '' }) {
  const preferred = preferredPath ? path.resolve(preferredPath) : '';
  const snapshots = listBackups({ root }).backups
    .filter((item) => item.reason === AUTH_SNAPSHOT_REASON)
    .sort((a, b) => {
      if (preferred && path.resolve(a.path) === preferred) return -1;
      if (preferred && path.resolve(b.path) === preferred) return 1;
      return 0;
    });
  const seen = new Map();
  const kept = [];
  const duplicates = [];
  const skipped = [];

  for (const item of snapshots) {
    if (!item.authHash) {
      skipped.push({ path: item.path, reason: 'auth.json hash unavailable' });
      continue;
    }
    const first = seen.get(item.authHash);
    if (!first) {
      seen.set(item.authHash, item);
      kept.push(item);
      continue;
    }
    duplicates.push({ ...item, duplicateOf: first.path });
  }

  const deleted = [];
  if (yes) {
    for (const item of duplicates) {
      const backup = resolveBackup(root, item.path);
      if (backup.manifest.reason !== AUTH_SNAPSHOT_REASON) {
        skipped.push({ path: item.path, reason: 'not a manual auth snapshot' });
        continue;
      }
      fs.rmSync(backup.path, { recursive: true, force: false });
      deleted.push(backup.path);
    }
  }

  return {
    root,
    total: snapshots.length,
    uniqueCount: kept.length,
    duplicateCount: duplicates.length,
    kept,
    duplicates: yes ? [] : duplicates,
    skipped,
    deleted,
    dryRun: !yes,
  };
}

function updateJsonlFiles(root, candidateRows, targetProvider, { journal = null, strict = false } = {}) {
  const candidateIds = new Set(candidateRows.map((row) => String(row.id)));
  const changed = [];
  const skipped = [];
  for (const dir of [path.join(root, 'sessions'), path.join(root, 'archived_sessions')]) {
    for (const file of walkFiles(dir, (full) => path.basename(full).startsWith('rollout-') && full.endsWith('.jsonl'))) {
      try {
        const text = fs.readFileSync(file, 'utf8');
        const hadFinalNewline = /\r?\n$/.test(text);
        const lines = text.split(/\r?\n/);
        if (!lines[0]) continue;
        const meta = JSON.parse(lines[0].replace(/^\uFEFF/, ''));
        if (meta.type !== 'session_meta' || !meta.payload) continue;
        if (!candidateIds.has(resolveThreadId(meta, file))) continue;
        meta.payload.model_provider = targetProvider;
        lines[0] = JSON.stringify(meta);
        let output = lines.join('\n');
        if (hadFinalNewline && !output.endsWith('\n')) output += '\n';
        if (journal) journal.write(file, output, 'utf8');
        else fs.writeFileSync(file, output, 'utf8');
        changed.push(file);
      } catch (error) {
        if (strict) throw error;
        skipped.push({ path: file, reason: error.message });
      }
    }
  }
  return { changed, skipped };
}

function rebuildSessionIndex(db, root) {
  const rows = queryRows(db, `
select id,
       coalesce(nullif(title,''), nullif(first_user_message,''), id) as thread_name,
       coalesce(updated_at_ms, updated_at * 1000) as updated_at_ms
from threads
where thread_source='user'
order by updated_at_ms desc, id desc;
`);
  const lines = rows.map((row) => JSON.stringify({
    id: row.id,
    thread_name: row.thread_name,
    updated_at: new Date(Number(row.updated_at_ms)).toISOString(),
  }));
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return lines.length;
}

function updateWorkspaceHints(db, root) {
  const statePath = path.join(root, '.codex-global-state.json');
  let state = {};
  if (fs.existsSync(statePath)) {
    const text = fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '');
    state = text.trim() ? JSON.parse(text) : {};
  }
  if (!state['thread-workspace-root-hints']) state['thread-workspace-root-hints'] = {};
  const hints = state['thread-workspace-root-hints'];
  let added = 0;
  for (const row of queryRows(db, "select id, cwd from threads where thread_source='user' order by updated_at desc;")) {
    const id = String(row.id);
    if (Object.prototype.hasOwnProperty.call(hints, id)) continue;
    const cwd = stripExtendedPrefix(String(row.cwd || ''));
    if (!cwd) continue;
    hints[id] = cwd;
    added += 1;
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  return added;
}

function verifyRestore(db, root) {
  const indexPath = path.join(root, 'session_index.jsonl');
  let INDEX_TOTAL = 0;
  let INDEX_BAD = 0;
  if (fs.existsSync(indexPath)) {
    for (const line of fs.readFileSync(indexPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      INDEX_TOTAL += 1;
      try { JSON.parse(line); } catch { INDEX_BAD += 1; }
    }
  }
  const nullRows = queryRows(db, "select count(*) as n from threads where thread_source is null or thread_source='';");
  const null_thread_source = nullRows.length ? Number(nullRows[0].n) : 0;
  const statePath = path.join(root, '.codex-global-state.json');
  let state = {};
  if (fs.existsSync(statePath)) {
    const text = fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '');
    state = text.trim() ? JSON.parse(text) : {};
  }
  const hints = state['thread-workspace-root-hints'] || {};
  const userRows = queryRows(db, "select id, model_provider from threads where thread_source='user';");
  const providerById = new Map();
  let USER_THREADS_MISSING_HINT = 0;
  for (const row of userRows) {
    const id = String(row.id);
    providerById.set(id, String(row.model_provider || ''));
    if (!Object.prototype.hasOwnProperty.call(hints, id)) USER_THREADS_MISSING_HINT += 1;
  }
  let JSONL_USER_MISMATCH = 0;
  let JSONL_LOCKED = 0;
  let JSONL_BAD = 0;
  for (const dir of [path.join(root, 'sessions'), path.join(root, 'archived_sessions')]) {
    for (const file of walkFiles(dir, (full) => path.basename(full).startsWith('rollout-') && full.endsWith('.jsonl'))) {
      try {
        const meta = firstJsonLine(file);
        if (!meta || meta.type !== 'session_meta' || !meta.payload) continue;
        const id = resolveThreadId(meta, file);
        if (!providerById.has(id)) continue;
        if (String(meta.payload.model_provider || '') !== providerById.get(id)) JSONL_USER_MISMATCH += 1;
      } catch (error) {
        if (/being used|cannot access|EBUSY|EPERM/i.test(error.message)) JSONL_LOCKED += 1;
        else JSONL_BAD += 1;
      }
    }
  }
  return { INDEX_TOTAL, INDEX_BAD, null_thread_source, USER_THREAD_ROWS: userRows.length, USER_THREADS_MISSING_HINT, JSONL_USER_MISMATCH, JSONL_LOCKED, JSONL_BAD };
}

function quoteIdentifier(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function normalizeTransferIds(threadIds) {
  if (!Array.isArray(threadIds)) throw new Error('Select one or more chats.');
  const seen = new Set();
  const ids = [];
  for (const value of threadIds) {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) throw new Error('Select one or more chats.');
  return ids;
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeThreadSchema(schema) {
  if (!Array.isArray(schema) || !schema.length) throw new Error('Migration package does not contain a threads schema.');
  const names = new Set();
  return schema.map((column) => {
    const name = String(column?.name || '').trim();
    if (!name || names.has(name)) throw new Error('Migration package contains an invalid threads schema.');
    names.add(name);
    return {
      name,
      type: String(column?.type || ''),
      notnull: Number(column?.notnull || 0) ? 1 : 0,
      dfltValue: column?.dfltValue === undefined || column?.dfltValue === null ? null : String(column.dfltValue),
      pk: Number(column?.pk || 0) ? 1 : 0,
    };
  });
}

function getThreadsSchema(db) {
  const rows = queryRows(db, 'pragma table_info(threads);');
  return normalizeThreadSchema(rows.map((row) => ({
    name: row.name,
    type: row.type,
    notnull: row.notnull,
    dfltValue: row.dflt_value,
    pk: row.pk,
  })));
}

function getThreadsSchemaFingerprint(schema) {
  return hashText(JSON.stringify(normalizeThreadSchema(schema)));
}

function encodeTransferValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Thread record contains an unsupported number.');
    return value;
  }
  if (typeof value === 'bigint') return { __historyTransferValue: 'bigint', value: value.toString() };
  if (Buffer.isBuffer(value)) return { __historyTransferValue: 'buffer', value: value.toString('base64') };
  throw new Error('Thread record contains an unsupported SQLite value.');
}

function decodeTransferValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Migration package contains an invalid SQLite value.');
  if (value.__historyTransferValue === 'bigint' && /^-?\d+$/.test(String(value.value || ''))) return BigInt(value.value);
  if (value.__historyTransferValue === 'buffer' && typeof value.value === 'string') return Buffer.from(value.value, 'base64');
  throw new Error('Migration package contains an unsupported SQLite value.');
}

function encodeTransferRecord(row) {
  const record = {};
  for (const [key, value] of Object.entries(row || {})) record[key] = encodeTransferValue(value);
  return record;
}

function decodeTransferRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Migration package contains an invalid thread record.');
  const output = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key || key.includes('\u0000')) throw new Error('Migration package contains an invalid thread column.');
    output[key] = decodeTransferValue(value);
  }
  return output;
}

function normalizeTransferRelativePath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw.includes('\u0000')) throw new Error('Migration package contains an invalid session path.');
  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error('Migration package contains an unsafe session path.');
  }
  const name = path.posix.basename(normalized);
  if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) {
    throw new Error('Migration package contains a non-session file.');
  }
  return normalized;
}

function readTransferSessionMeta(content, id, relativePath) {
  const first = String(content || '').split(/\r?\n/, 1)[0].replace(/^\uFEFF/, '');
  let meta;
  try {
    meta = first ? JSON.parse(first) : null;
  } catch (error) {
    throw new Error('Migration package contains invalid JSONL metadata: ' + error.message);
  }
  if (!meta || meta.type !== 'session_meta' || !meta.payload) {
    throw new Error('Migration package contains a session without session_meta.');
  }
  const foundId = resolveThreadId(meta, relativePath);
  if (!foundId || String(foundId) !== String(id)) {
    throw new Error('Migration package session metadata does not match its thread ID.');
  }
  return meta;
}

function normalizeTransferSessionFile(file, id) {
  const storage = String(file?.storage || '');
  if (!RESTORABLE_DIR_NAMES.includes(storage)) throw new Error('Migration package contains an unsupported session location.');
  const relativePath = normalizeTransferRelativePath(file?.relativePath);
  const content = String(file?.content || '');
  const size = Buffer.byteLength(content, 'utf8');
  if (!content || size > HISTORY_TRANSFER_MAX_UNPACKED_BYTES) {
    throw new Error('Migration package contains an invalid session payload.');
  }
  const sha256 = String(file?.sha256 || '');
  if (!/^[a-f0-9]{64}$/i.test(sha256) || hashText(content) !== sha256) {
    throw new Error('Migration package session checksum verification failed.');
  }
  readTransferSessionMeta(content, id, relativePath);
  return { storage, relativePath, content, sha256, size };
}

function buildSessionFileIndex(root, expectedIds = null, { includeContent = true } = {}) {
  const wanted = expectedIds ? new Set([...expectedIds].map((id) => String(id))) : null;
  const byId = new Map();
  const issues = [];

  for (const storage of RESTORABLE_DIR_NAMES) {
    const storageRoot = path.join(root, storage);
    for (const file of walkFiles(storageRoot, (full) => path.basename(full).startsWith('rollout-') && full.endsWith('.jsonl'))) {
      try {
        const meta = firstJsonLine(file);
        if (!meta || meta.type !== 'session_meta' || !meta.payload) continue;
        const id = resolveThreadId(meta, file);
        if (!id || (wanted && !wanted.has(String(id)))) continue;
        const relativePath = path.relative(storageRoot, file).split(path.sep).join('/');
        const content = includeContent ? fs.readFileSync(file, 'utf8') : '';
        const entry = {
          storage,
          relativePath,
          size: includeContent ? Buffer.byteLength(content, 'utf8') : fs.statSync(file).size,
        };
        if (includeContent) {
          entry.content = content;
          entry.sha256 = hashText(content);
        }
        if (!byId.has(String(id))) byId.set(String(id), []);
        byId.get(String(id)).push(entry);
      } catch (error) {
        issues.push({ path: file, reason: error.message });
      }
    }
  }

  for (const files of byId.values()) {
    files.sort((left, right) => (left.storage + '/' + left.relativePath).localeCompare(right.storage + '/' + right.relativePath));
  }
  return { byId, issues };
}

function canonicalTransferRecord(record) {
  const ordered = {};
  for (const key of Object.keys(record || {}).sort()) ordered[key] = record[key];
  return ordered;
}

function getTransferThreadHash(record, sessionFiles) {
  const files = sessionFiles
    .map((file) => ({
      storage: file.storage,
      relativePath: file.relativePath,
      sha256: file.sha256,
      size: file.size,
    }))
    .sort((left, right) => (left.storage + '/' + left.relativePath).localeCompare(right.storage + '/' + right.relativePath));
  return hashText(JSON.stringify({ record: canonicalTransferRecord(record), files }));
}

function getTransferThreadSummary(row) {
  const updatedAtMs = Number((row?.updated_at_ms ?? (Number(row?.updated_at || 0) * 1000)) || 0);
  return {
    title: String(row?.title || row?.first_user_message || row?.id || ''),
    modelProvider: String(row?.model_provider || ''),
    archived: Boolean(row?.archived),
    cwd: String(row?.cwd || ''),
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
  };
}

function normalizeHistoryTransferOutputPath(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Choose a destination for the migration package.');
  const output = path.resolve(raw);
  return output.toLowerCase().endsWith(HISTORY_TRANSFER_EXTENSION) ? output : output + HISTORY_TRANSFER_EXTENSION;
}

async function writeHistoryTransfer(outputPath, bundle) {
  const target = normalizeHistoryTransferOutputPath(outputPath);
  if (fs.existsSync(target)) throw new Error('Migration package already exists: ' + target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = Buffer.from(JSON.stringify(bundle), 'utf8');
  if (payload.length > HISTORY_TRANSFER_MAX_UNPACKED_BYTES) {
    throw new Error('Migration package is too large. Export fewer chats at a time.');
  }
  const compressed = await gzipAsync(payload, { level: 9 });
  if (compressed.length > HISTORY_TRANSFER_MAX_BYTES) {
    throw new Error('Compressed migration package is too large. Export fewer chats at a time.');
  }
  const temporary = target + '.partial-' + process.pid + '-' + Date.now();
  await fs.promises.writeFile(temporary, compressed, { flag: 'wx' });
  try {
    if (fs.existsSync(target)) throw new Error('Migration package already exists: ' + target);
    await fs.promises.rename(temporary, target);
  } catch (error) {
    try { await fs.promises.rm(temporary, { force: true }); } catch {}
    throw error;
  }
  return { path: target, bytes: compressed.length, unpackedBytes: payload.length };
}

async function readHistoryTransfer(packagePath) {
  const resolved = path.resolve(String(packagePath || '').trim());
  if (!resolved || !fs.existsSync(resolved)) throw new Error('Migration package does not exist: ' + (packagePath || '(empty)'));
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile() || stat.size > HISTORY_TRANSFER_MAX_BYTES) throw new Error('Migration package is not a supported file.');
  let decoded;
  try {
    decoded = await gunzipAsync(await fs.promises.readFile(resolved), { maxOutputLength: HISTORY_TRANSFER_MAX_UNPACKED_BYTES });
  } catch (error) {
    throw new Error('Migration package cannot be decompressed: ' + error.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error('Migration package is not valid JSON: ' + error.message);
  }
  return { path: resolved, bundle: validateHistoryTransfer(parsed), bytes: stat.size };
}

function validateHistoryTransfer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Migration package is invalid.');
  if (value.format !== HISTORY_TRANSFER_FORMAT || Number(value.formatVersion) !== HISTORY_TRANSFER_VERSION) {
    throw new Error('Migration package format is not supported.');
  }
  const sourceSchema = normalizeThreadSchema(value.source?.threadSchema);
  const sourceFingerprint = String(value.source?.schemaFingerprint || '');
  if (sourceFingerprint !== getThreadsSchemaFingerprint(sourceSchema)) {
    throw new Error('Migration package schema fingerprint does not match its contents.');
  }
  if (!Array.isArray(value.threads) || !value.threads.length) throw new Error('Migration package contains no chats.');
  const ids = new Set();
  const threads = value.threads.map((raw) => {
    const id = String(raw?.id || '').trim();
    if (!id || ids.has(id)) throw new Error('Migration package contains duplicate or invalid chat IDs.');
    ids.add(id);
    const decodedRecord = decodeTransferRecord(raw.record);
    if (String(decodedRecord.id || '') !== id) throw new Error('Migration package thread ID does not match its record.');
    if (String(decodedRecord.thread_source || '') !== 'user') throw new Error('Migration package contains a non-user thread.');
    const record = encodeTransferRecord(decodedRecord);
    const sessionFiles = (raw.sessionFiles || []).map((file) => normalizeTransferSessionFile(file, id));
    if (!sessionFiles.length) throw new Error('Migration package contains a chat without transcript data.');
    const contentHash = getTransferThreadHash(record, sessionFiles);
    if (String(raw.contentHash || '') !== contentHash) throw new Error('Migration package chat checksum verification failed.');
    return {
      id,
      record,
      summary: getTransferThreadSummary(decodedRecord),
      sessionFiles,
      contentHash,
    };
  });
  return {
    format: HISTORY_TRANSFER_FORMAT,
    formatVersion: HISTORY_TRANSFER_VERSION,
    createdAt: String(value.createdAt || ''),
    source: { threadSchema: sourceSchema, schemaFingerprint: sourceFingerprint },
    threads,
  };
}

function listTransferThreads({ root }) {
  return withDatabase(root, true, (db) => {
    const schema = getThreadsSchema(db);
    const columns = new Set(schema.map((column) => column.name));
    if (!columns.has('id') || !columns.has('thread_source')) throw new Error('The threads table is not compatible with migration.');
    const title = columns.has('title') && columns.has('first_user_message')
      ? "coalesce(nullif(title,''), nullif(first_user_message,''), id)"
      : columns.has('title') ? "coalesce(nullif(title,''), id)" : 'id';
    const provider = columns.has('model_provider') ? 'model_provider' : "''";
    const archived = columns.has('archived') ? 'archived' : '0';
    const cwd = columns.has('cwd') ? 'cwd' : "''";
    const updated = columns.has('updated_at_ms') && columns.has('updated_at')
      ? 'coalesce(updated_at_ms, updated_at * 1000, 0)'
      : columns.has('updated_at_ms') ? 'coalesce(updated_at_ms, 0)'
        : columns.has('updated_at') ? 'coalesce(updated_at * 1000, 0)' : '0';
    const rows = queryRows(db,
      'select id, ' + title + ' as title, ' + provider + ' as model_provider, ' + archived + ' as archived, ' + cwd + ' as cwd, ' + updated + ' as updated_at_ms ' +
      "from threads where thread_source='user' order by updated_at_ms desc, id desc;"
    );
    const sessionIndex = buildSessionFileIndex(root, null, { includeContent: false });
    return {
      root,
      schemaFingerprint: getThreadsSchemaFingerprint(schema),
      threads: rows.map((row) => {
        const files = sessionIndex.byId.get(String(row.id)) || [];
        return {
          id: String(row.id),
          ...getTransferThreadSummary(row),
          sessionCount: files.length,
          exportable: files.length > 0,
        };
      }),
      sessionIssues: sessionIndex.issues,
    };
  });
}

async function exportHistoryTransfer({ root, threadIds, outputPath }) {
  const ids = normalizeTransferIds(threadIds);
  const prepared = withDatabase(root, true, (db) => {
    const schema = getThreadsSchema(db);
    const rows = queryRows(db,
      'select * from threads where id in (' + ids.map(sqlQuote).join(',') + ") and thread_source='user';"
    );
    const rowsById = new Map(rows.map((row) => [String(row.id), row]));
    const sessionIndex = buildSessionFileIndex(root, new Set(ids));
    const skipped = [];
    const threads = [];

    for (const id of ids) {
      const row = rowsById.get(id);
      if (!row) {
        skipped.push({ id, reason: 'Chat was not found or is not a user chat.' });
        continue;
      }
      const sessionFiles = sessionIndex.byId.get(id) || [];
      if (!sessionFiles.length) {
        skipped.push({ id, reason: 'No readable JSONL transcript was found for this chat.' });
        continue;
      }
      const record = encodeTransferRecord(row);
      const files = sessionFiles.map((file) => ({
        storage: file.storage,
        relativePath: file.relativePath,
        content: file.content,
        sha256: file.sha256,
        size: file.size,
      }));
      threads.push({
        id,
        record,
        summary: getTransferThreadSummary(row),
        sessionFiles: files,
        contentHash: getTransferThreadHash(record, files),
      });
    }

    if (!threads.length) throw new Error('None of the selected chats has a readable transcript.');
    return {
      bundle: {
        format: HISTORY_TRANSFER_FORMAT,
        formatVersion: HISTORY_TRANSFER_VERSION,
        createdAt: new Date().toISOString(),
        source: {
          threadSchema: schema,
          schemaFingerprint: getThreadsSchemaFingerprint(schema),
        },
        threads,
      },
      skipped,
    };
  });

  const written = await writeHistoryTransfer(outputPath, prepared.bundle);
  return {
    packagePath: written.path,
    bytes: written.bytes,
    unpackedBytes: written.unpackedBytes,
    requested: ids.length,
    exported: prepared.bundle.threads.length,
    skipped: prepared.skipped,
  };
}
function getHistoryTransferDestination(root, storage, relativePath) {
  const storageRoot = path.resolve(root, storage);
  const destination = path.resolve(storageRoot, ...String(relativePath).split('/'));
  if (!isInside(storageRoot, destination) || destination === storageRoot) {
    throw new Error('Migration package contains an unsafe destination path.');
  }
  if (fs.existsSync(storageRoot)) {
    const realStorageRoot = fs.realpathSync.native(storageRoot);
    let existingAncestor = destination;
    while (!fs.existsSync(existingAncestor) && existingAncestor !== storageRoot) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) break;
      existingAncestor = parent;
    }
    if (fs.existsSync(existingAncestor)) {
      const realAncestor = fs.realpathSync.native(existingAncestor);
      if (!isInside(realStorageRoot, realAncestor)) {
        throw new Error('Migration package destination crosses a linked directory outside the session root.');
      }
    }
  }
  return destination;
}

function getHistoryTransferPreview(root, db, transfer) {
  const targetSchema = getThreadsSchema(db);
  const targetFingerprint = getThreadsSchemaFingerprint(targetSchema);
  const schemaCompatible = targetFingerprint === transfer.source.schemaFingerprint;
  const ids = transfer.threads.map((thread) => thread.id);
  const existingRows = queryRows(db, 'select * from threads where id in (' + ids.map(sqlQuote).join(',') + ');');
  const existingById = new Map(existingRows.map((row) => [String(row.id), row]));
  const sessionIndex = buildSessionFileIndex(root, new Set(ids));

  const threads = transfer.threads.map((thread) => {
    if (!schemaCompatible) {
      return {
        ...thread.summary,
        id: thread.id,
        status: 'incompatible',
        reason: 'The source and target threads table schemas are different.',
        sessionCount: thread.sessionFiles.length,
        canImport: false,
      };
    }
    const existing = existingById.get(thread.id);
    const existingFiles = sessionIndex.byId.get(thread.id) || [];
    if (!existing && !existingFiles.length) {
      return {
        ...thread.summary,
        id: thread.id,
        status: 'new',
        reason: '',
        sessionCount: thread.sessionFiles.length,
        canImport: true,
      };
    }
    let targetHash = '';
    try {
      targetHash = existing
        ? getTransferThreadHash(encodeTransferRecord(existing), existingFiles)
        : '';
    } catch {}
    const duplicate = Boolean(existing && existingFiles.length && targetHash === thread.contentHash);
    return {
      ...thread.summary,
      id: thread.id,
      status: duplicate ? 'duplicate' : 'conflict',
      reason: duplicate ? 'The same chat is already present in the target.' : 'The target already has this chat ID with different data.',
      sessionCount: thread.sessionFiles.length,
      canImport: false,
    };
  });

  const counts = { new: 0, duplicate: 0, conflict: 0, incompatible: 0 };
  for (const thread of threads) counts[thread.status] += 1;
  return {
    schemaCompatible,
    sourceSchemaFingerprint: transfer.source.schemaFingerprint,
    targetSchemaFingerprint: targetFingerprint,
    suggestedTarget: readConfigModelProvider(root),
    threads,
    counts,
    sessionIssues: sessionIndex.issues,
  };
}

async function inspectHistoryTransfer({ root, packagePath }) {
  const transfer = await readHistoryTransfer(packagePath);
  const preview = withDatabase(root, true, (db) => getHistoryTransferPreview(root, db, transfer.bundle));
  return {
    packagePath: transfer.path,
    bytes: transfer.bytes,
    createdAt: transfer.bundle.createdAt,
    total: transfer.bundle.threads.length,
    ...preview,
  };
}

function normalizeWorkspaceMapping(source, target) {
  const from = String(source || '').trim();
  const to = String(target || '').trim();
  if (!from && !to) return null;
  if (!from || !to) throw new Error('Fill in both workspace path mapping fields or leave both empty.');
  const normalize = (value) => {
    const converted = value.replace(/\//g, '\\');
    if (/^[A-Za-z]:\\$/.test(converted)) return converted;
    return converted.replace(/\\+$/, '');
  };
  return { from: normalize(from), to: normalize(to) };
}

function mapWorkspacePath(value, mapping) {
  if (!mapping || !value) return value;
  const original = stripExtendedPrefix(String(value));
  const comparable = original.toLowerCase();
  const source = mapping.from.toLowerCase();
  if (comparable !== source && !comparable.startsWith(source + '\\')) return original;
  return mapping.to + original.slice(mapping.from.length);
}

function rewriteTransferSessionContent(file, id, provider, mapping) {
  const hadFinalNewline = /\r?\n$/.test(file.content);
  const lines = file.content.split(/\r?\n/);
  if (!lines[0]) throw new Error('Migration package contains an empty JSONL session.');
  const meta = readTransferSessionMeta(file.content, id, file.relativePath);
  if (provider !== null) meta.payload.model_provider = provider;
  if (mapping && typeof meta.payload.cwd === 'string') meta.payload.cwd = mapWorkspacePath(meta.payload.cwd, mapping);
  lines[0] = JSON.stringify(meta);
  let content = lines.join('\n');
  if (hadFinalNewline && !content.endsWith('\n')) content += '\n';
  return {
    ...file,
    content,
    sha256: hashText(content),
    size: Buffer.byteLength(content, 'utf8'),
  };
}

function prepareHistoryTransferImport(transferThreads, targetProvider, mapping) {
  const providerOverride = String(targetProvider || '').trim();
  return transferThreads.map((thread) => {
    const record = decodeTransferRecord(thread.record);
    if (String(record.id || '') !== thread.id || String(record.thread_source || '') !== 'user') {
      throw new Error('Migration package thread record failed validation.');
    }
    if (!Object.prototype.hasOwnProperty.call(record, 'model_provider')) {
      throw new Error('The threads schema does not expose model_provider.');
    }
    const provider = providerOverride || String(record.model_provider || '');
    record.model_provider = provider;
    if (mapping && typeof record.cwd === 'string') record.cwd = mapWorkspacePath(record.cwd, mapping);
    const sessionFiles = thread.sessionFiles.map((file) => rewriteTransferSessionContent(file, thread.id, provider, mapping));
    return {
      id: thread.id,
      record,
      summary: {
        ...thread.summary,
        modelProvider: provider,
        cwd: typeof record.cwd === 'string' ? record.cwd : '',
      },
      sessionFiles,
    };
  });
}

function validateHistoryTransferDestinations(root, threads) {
  for (const thread of threads) {
    for (const file of thread.sessionFiles) {
      const destination = getHistoryTransferDestination(root, file.storage, file.relativePath);
      if (fs.existsSync(destination)) {
        throw new Error('Target session file already exists: ' + destination);
      }
    }
  }
}

function createHistoryTransferStaging(root) {
  const staging = path.join(root, HISTORY_TRANSFER_STAGING_PREFIX + crypto.randomUUID());
  fs.mkdirSync(staging, { recursive: false });
  return staging;
}

function removeHistoryTransferStaging(root, staging) {
  if (!staging || !isInside(root, staging) || !path.basename(staging).startsWith(HISTORY_TRANSFER_STAGING_PREFIX)) return;
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
}

function stageHistoryTransferFiles(staging, threads) {
  for (const thread of threads) {
    for (const file of thread.sessionFiles) {
      const staged = getHistoryTransferDestination(staging, file.storage, file.relativePath);
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.writeFileSync(staged, file.content, { encoding: 'utf8', flag: 'wx' });
    }
  }
}

function insertHistoryTransferThreads(db, threads) {
  const schema = getThreadsSchema(db);
  const columns = schema.filter((column) => Object.prototype.hasOwnProperty.call(threads[0].record, column.name));
  if (!columns.some((column) => column.name === 'id')) throw new Error('Migration package does not contain a thread ID.');
  for (const thread of threads) {
    for (const column of schema) {
      if (!column.notnull || column.dfltValue !== null || Object.prototype.hasOwnProperty.call(thread.record, column.name)) continue;
      throw new Error('Migration package does not contain required column: ' + column.name);
    }
  }
  const names = columns.map((column) => column.name);
  const sql = 'insert into ' + quoteIdentifier('threads') + ' (' + names.map(quoteIdentifier).join(', ') + ') values (' + names.map(() => '?').join(', ') + ');';
  const insert = db.prepare(sql);
  runImmediateTransaction(db, () => {
    for (const thread of threads) {
      const values = names.map((name) => thread.record[name] === undefined ? null : thread.record[name]);
      insert.run(...values);
    }
  });
  return threads.length;
}

function deleteHistoryTransferThreads(root, ids) {
  if (!ids.length) return;
  withDatabase(root, false, (db) => {
    runImmediateTransaction(db, () => {
      db.prepare('delete from threads where id in (' + ids.map(sqlQuote).join(',') + ');').run();
    });
    checkpoint(db);
  });
}

function moveStagedHistoryTransferFiles(root, staging, threads, moved = []) {
  for (const thread of threads) {
    for (const file of thread.sessionFiles) {
      const staged = getHistoryTransferDestination(staging, file.storage, file.relativePath);
      const destination = getHistoryTransferDestination(root, file.storage, file.relativePath);
      if (fs.existsSync(destination)) throw new Error('Target session file already exists: ' + destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(staged, destination);
      moved.push(destination);
    }
  }
  return moved;
}

function isSuccessfulVerification(verify) {
  return verify
    && verify.INDEX_BAD === 0
    && verify.null_thread_source === 0
    && verify.USER_THREADS_MISSING_HINT === 0
    && verify.JSONL_USER_MISMATCH === 0
    && verify.JSONL_LOCKED === 0
    && verify.JSONL_BAD === 0;
}

async function importHistoryTransfer({ root, packagePath, threadIds, targetProvider = '', workspacePathFrom = '', workspacePathTo = '' }) {
  const selectedIds = normalizeTransferIds(threadIds);
  const transfer = await readHistoryTransfer(packagePath);
  const preview = withDatabase(root, true, (db) => getHistoryTransferPreview(root, db, transfer.bundle));
  if (!preview.schemaCompatible) {
    throw new Error('The migration package is not compatible with the target Codex database schema.');
  }

  const previewById = new Map(preview.threads.map((thread) => [thread.id, thread]));
  const incomingById = new Map(transfer.bundle.threads.map((thread) => [thread.id, thread]));
  const skipped = [];
  const selected = [];
  for (const id of selectedIds) {
    const previewThread = previewById.get(id);
    const incoming = incomingById.get(id);
    if (!previewThread || !incoming) {
      skipped.push({ id, reason: 'Chat is not present in the selected migration package.' });
      continue;
    }
    if (previewThread.status !== 'new') {
      skipped.push({ id, reason: previewThread.reason || 'Chat cannot be imported safely.' });
      continue;
    }
    selected.push(incoming);
  }
  if (!selected.length) {
    return {
      packagePath: transfer.path,
      backup: '',
      imported: [],
      skipped,
      jsonlImported: 0,
      passed: false,
      verify: null,
      note: 'No selected chat can be imported safely.',
    };
  }

  const mapping = normalizeWorkspaceMapping(workspacePathFrom, workspacePathTo);
  const prepared = prepareHistoryTransferImport(selected, targetProvider, mapping);
  validateHistoryTransferDestinations(root, prepared);
  const safety = createCodexStateBackup(root, { reason: 'pre-chat-history-import', includeSubagents: true });
  const staging = createHistoryTransferStaging(root);
  let inserted = false;
  let moved = [];

  try {
    stageHistoryTransferFiles(staging, prepared);
    withDatabase(root, false, (db) => {
      insertHistoryTransferThreads(db, prepared);
      inserted = true;
    });
    moveStagedHistoryTransferFiles(root, staging, prepared, moved);
  } catch (error) {
    const rollbackErrors = [];
    if (inserted) {
      try { deleteHistoryTransferThreads(root, prepared.map((thread) => thread.id)); } catch (rollbackError) { rollbackErrors.push(`database: ${rollbackError.message}`); }
    }
    for (const file of moved.reverse()) {
      try { fs.rmSync(file, { force: true }); } catch (rollbackError) { rollbackErrors.push(`file ${file}: ${rollbackError.message}`); }
    }
    removeHistoryTransferStaging(root, staging);
    if (rollbackErrors.length) error.message += ` Import rollback also failed: ${rollbackErrors.join('; ')}`;
    throw error;
  }
  removeHistoryTransferStaging(root, staging);

  let indexLines = 0;
  let workspaceHintsAdded = 0;
  let verify = null;
  let postError = '';
  try {
    withDatabase(root, false, (db) => {
      checkpoint(db);
      indexLines = rebuildSessionIndex(db, root);
      workspaceHintsAdded = updateWorkspaceHints(db, root);
      verify = verifyRestore(db, root);
    });
  } catch (error) {
    postError = error.message;
  }

  return {
    packagePath: transfer.path,
    backup: safety.backup,
    backupSkipped: safety.skipped,
    imported: prepared.map((thread) => thread.summary),
    skipped,
    jsonlImported: moved.length,
    indexLines,
    workspaceHintsAdded,
    verify,
    passed: !postError && isSuccessfulVerification(verify),
    postError,
  };
}
function getDefaults() {
  const root = path.join(process.env.USERPROFILE || '', '.codex');
  return { root, rootExists: fs.existsSync(path.join(root, 'state_5.sqlite')), sqliteEngine: 'node:sqlite' };
}

function scanState({ root }) {
  const auth = readAuthSummary(root);
  return withDatabase(root, true, (db) => {
    const latestRows = queryRows(db, `
select id, title, model_provider
from threads
where thread_source='user'
  and model_provider is not null
  and model_provider <> ''
order by coalesce(updated_at_ms, updated_at * 1000) desc
limit 1;
`);
    const providerRows = queryRows(db, `
select model_provider, archived, quote(thread_source) as thread_source, count(*) as n
from threads
where model_provider is not null and model_provider <> ''
group by model_provider, archived, thread_source
order by model_provider, archived, thread_source;
`);
    const providers = [...new Set(providerRows.map((row) => String(row.model_provider || '')).filter(Boolean))];
    const latestUser = latestRows[0] || null;
    const configModelProvider = readConfigModelProvider(root);
    return {
      root,
      sqliteEngine: 'node:sqlite',
      auth,
      authMode: auth.authMode,
      hasApiKey: auth.hasApiKey,
      latestUser,
      providerRows,
      providers,
      configModelProvider,
      suggestedTarget: configModelProvider || '',
    };
  });
}

function buildPlan({ root, targetProvider, oldProviders, includeSubagents }) {
  if (!targetProvider || !String(targetProvider).trim()) throw new Error('Target provider is required.');
  if ((oldProviders || []).includes(targetProvider)) throw new Error('Old providers cannot include the target provider.');
  return withDatabase(root, true, (db) => {
    const candidates = getCandidateRows(db, Boolean(includeSubagents), oldProviders || []);
    const jsonl = getJsonlPlan(root, candidates);
    const nullRows = queryRows(db, "select count(*) as n from threads where (thread_source is null or thread_source='') and source='vscode';");
    return { targetProvider, oldProviders: oldProviders || [], includeSubagents: Boolean(includeSubagents), threadsToMigrate: candidates.length, jsonlToChange: jsonl.toChange, jsonlLockedDryRun: jsonl.locked, jsonlBadDryRun: jsonl.bad, nullThreadSourceToUser: nullRows.length ? Number(nullRows[0].n) : 0, candidates };
  });
}

function applyRestore({ root, targetProvider, oldProviders, includeSubagents }) {
  const backup = backupCodexState(root, targetProvider, oldProviders || [], Boolean(includeSubagents));
  return runCoordinatedMutation(root, (db, journal) => {
    db.prepare("update threads set thread_source='user' where (thread_source is null or thread_source='') and source='vscode';").run();
    const candidates = getCandidateRows(db, Boolean(includeSubagents), oldProviders || []);
    const jsonl = updateJsonlFiles(root, candidates, targetProvider, { journal, strict: true });
    if (candidates.length) {
      const updateProvider = db.prepare('update threads set model_provider=? where id=?;');
      for (const row of candidates) updateProvider.run(targetProvider, row.id);
    }
    journal.capture(path.join(root, 'session_index.jsonl'));
    const indexLines = rebuildSessionIndex(db, root);
    journal.capture(path.join(root, '.codex-global-state.json'));
    const workspaceHintsAdded = updateWorkspaceHints(db, root);
    journal.capture(path.join(root, 'config.toml'));
    const config = updateConfigModelProvider(root, targetProvider);
    const verify = verifyRestore(db, root);
    if (!isSuccessfulVerification(verify)) throw new Error('Restore verification failed; all changes were reverted.');
    return { backup: backup.backup, backupSkipped: backup.skipped, config, jsonlChanged: jsonl.changed.length, jsonlSkipped: jsonl.skipped, indexLines, workspaceHintsAdded, verify, passed: true };
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function normalizeError(error) {
  return { message: error?.message || String(error) };
}

function readBody(req, maxBytes = API_BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('Request body is too large.'));
        return;
      }
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function parseCookies(value) {
  const cookies = new Map();
  for (const part of String(value || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

function isAuthorizedApiRequest(req, apiToken) {
  if (req.method !== 'POST') return false;
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return false;
  const token = parseCookies(req.headers.cookie).get(API_COOKIE_NAME) || '';
  if (!token || token.length !== apiToken.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(apiToken))) return false;
  const origin = String(req.headers.origin || '');
  if (origin && origin !== `http://${req.headers.host}`) return false;
  return true;
}

async function handleApi(req, res, apiToken) {
  if (!isAuthorizedApiRequest(req, apiToken)) {
    return sendJson(res, 403, { ok: false, error: { message: 'Request rejected. Reload the recovery tool and try again.' } });
  }
  try {
    const body = await readBody(req);
    if (req.url === '/api/defaults') return sendJson(res, 200, { ok: true, data: getDefaults() });
    if (req.url === '/api/backups') return sendJson(res, 200, { ok: true, data: listBackups(body) });
    if (req.url === '/api/backup-content') return sendJson(res, 200, { ok: true, data: readBackupContent(body) });
    if (req.url === '/api/apply-backup-content') return sendJson(res, 200, { ok: true, data: applyBackupContent(body) });
    if (req.url === '/api/rename-backup-auth') return sendJson(res, 200, { ok: true, data: renameBackupAuth(body) });
    if (req.url === '/api/scan') return sendJson(res, 200, { ok: true, data: scanState(body) });
    if (req.url === '/api/transfer-threads') return sendJson(res, 200, { ok: true, data: listTransferThreads(body) });
    if (req.url === '/api/export-transfer') return sendJson(res, 200, { ok: true, data: await exportHistoryTransfer(body) });
    if (req.url === '/api/inspect-transfer') return sendJson(res, 200, { ok: true, data: await inspectHistoryTransfer(body) });
    if (req.url === '/api/import-transfer') return sendJson(res, 200, { ok: true, data: await importHistoryTransfer(body) });
    if (req.url === '/api/plan') return sendJson(res, 200, { ok: true, data: buildPlan(body) });
    if (req.url === '/api/apply') return sendJson(res, 200, { ok: true, data: applyRestore(body) });
    if (req.url === '/api/save-auth-snapshot') return sendJson(res, 200, { ok: true, data: createAuthSnapshot(body) });
    if (req.url === '/api/restore-backup') return sendJson(res, 200, { ok: true, data: restoreSettingsFromBackup(body) });
    if (req.url === '/api/delete-backup') return sendJson(res, 200, { ok: true, data: deleteBackup(body) });
    if (req.url === '/api/cleanup-backups') return sendJson(res, 200, { ok: true, data: cleanupExpiredBackups(body) });
    return sendJson(res, 404, { ok: false, error: { message: 'Not found' } });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: normalizeError(error) });
  }
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, apiToken) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(DIST, rel);
  const headers = {
    'Set-Cookie': `${API_COOKIE_NAME}=${apiToken}; HttpOnly; SameSite=Strict; Path=/`,
    'Cache-Control': 'no-store',
  };
  if (!isInside(DIST, file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const fallback = path.join(DIST, 'index.html');
    res.writeHead(200, { ...headers, 'Content-Type': mime['.html'] });
    res.end(fs.readFileSync(fallback));
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

function ensureBuiltFrontend() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('Missing dist/index.html. Run: npm run build');
  }
}

function createHttpServer(apiToken) {
  return http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/')) return handleApi(req, res, apiToken);
    return serveStatic(req, res, apiToken);
  });
}

function createServer(port = 47321, options = {}) {
  const host = options.host || '127.0.0.1';
  const startPort = Number(port) || 47321;
  const maxPort = startPort + 100;
  const shouldOpenBrowser = options.openBrowser !== false && process.env.NO_OPEN !== '1';
  const shouldLog = options.log !== false;
  const mode = options.mode || 'browser';
  const apiToken = crypto.randomBytes(32).toString('hex');

  ensureBuiltFrontend();

  return new Promise((resolve, reject) => {
    const listen = (nextPort) => {
      const server = createHttpServer(apiToken);
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && nextPort < maxPort) {
          listen(nextPort + 1);
          return;
        }
        reject(error);
      });
      server.listen(nextPort, host, () => {
        const url = `http://${host}:${nextPort}`;
        if (shouldLog) {
          console.log(`Codex History Recovery is running at ${url}`);
          if (mode === 'browser') console.log('Keep this window open while using the browser launcher.');
        }
        if (shouldOpenBrowser) exec(`cmd /c start "" "${url}"`);
        resolve({ server, port: nextPort, url });
      });
    };

    listen(startPort);
  });
}

async function startStandalone() {
  try {
    await createServer(47321);
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }
}

if (require.main === module) startStandalone();

module.exports = {
  createServer,
  _internal: {
    applyBackupContent,
    applyRestore,
    createAuthSnapshot,
    createCodexStateBackup,
    deleteBackup,
    isAuthorizedApiRequest,
    listBackups,
    readBackupContent,
    renameBackupAuth,
    exportHistoryTransfer,
    getHistoryTransferDestination,
    importHistoryTransfer,
    inspectHistoryTransfer,
    listTransferThreads,
  },
};
