const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { exec } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const THREAD_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BACKUP_DIR_RE = /^backup-\d{8}-\d{6}-.+/;
const PROJECT_BACKUP_REASONS = new Set(['pre-chat-history-restore', 'pre-backup-restore', 'pre-settings-rollback']);
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

function firstJsonLine(file) {
  const text = fs.readFileSync(file, 'utf8');
  const first = text.split(/\r?\n/, 1)[0].replace(/^\uFEFF/, '');
  return first ? JSON.parse(first) : null;
}

function readTextIfExists(file) {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
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
    authMode: '',
    hasApiKey: false,
    likelyAccountAuth: false,
    authType: 'missing',
    signals: [],
    error: '',
  };
  if (!summary.exists) return summary;
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

function createCodexStateBackup(root, { targetProvider = '', oldProviders = [], includeSubagents = false, reason = 'pre-chat-history-restore' } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const backup = path.join(root, `backup-${stamp}-${reason}`);
  const skipped = [];
  fs.mkdirSync(path.join(backup, 'files'), { recursive: true });
  for (const name of STATE_FILE_NAMES) {
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
      const auth = readAuthSummaryFromPath(path.join(backupPath, 'auth.json'));
      return {
        name: entry.name,
        path: backupPath,
        createdAt: manifest.createdAt || stat.mtime.toISOString(),
        reason: manifest.reason || '',
        targetProvider: manifest.targetProvider || '',
        includeSubagents: Boolean(manifest.includeSubagents),
        hasAuthJson: auth.exists,
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

function restoreThreadSettingsFromBackup(currentDb, backupDb) {
  const current = readThreadSettings(currentDb);
  const backup = readThreadSettings(backupDb);
  const fields = backup.fields.filter((field) => current.fields.includes(field));
  if (!fields.length) return { matched: 0, changed: 0, fields, missing: backup.rows.length };

  const currentById = new Map(current.rows.map((row) => [String(row.id), row]));
  const update = currentDb.prepare(`update threads set ${fields.map((field) => `${field}=?`).join(', ')} where id=?;`);
  let matched = 0;
  let changed = 0;
  let missing = 0;

  runImmediateTransaction(currentDb, () => {
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
  });

  return { matched, changed, fields, missing };
}

function updateJsonlProvidersFromBackup(root, backupDb) {
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
        fs.writeFileSync(file, output, 'utf8');
        changed.push(file);
      } catch (error) {
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
    return withDatabase(root, false, (db) => {
      const threads = restoreThreadSettingsFromBackup(db, backupDb);
      checkpoint(db);
      const jsonl = updateJsonlProvidersFromBackup(root, backupDb);
      const indexLines = rebuildSessionIndex(db, root);
      const workspaceHintsAdded = updateWorkspaceHints(db, root);
      const config = restoreConfigProviderFromBackup(root, backup.path);
      const verify = verifyRestore(db, root);
      const passed = verify.INDEX_BAD === 0 && verify.null_thread_source === 0 && verify.USER_THREADS_MISSING_HINT === 0 && verify.JSONL_USER_MISMATCH === 0 && verify.JSONL_BAD === 0;
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
        passed,
      };
    });
  } finally {
    backupDb.close();
  }
}

function restoreAuthFromBackup({ root, backupPath }) {
  if (!root || !fs.existsSync(root)) throw new Error(`Missing Codex root: ${root || '(empty)'}`);
  const backup = resolveBackup(root, backupPath);
  const src = path.join(backup.path, 'auth.json');
  if (!fs.existsSync(src)) throw new Error('Selected backup does not contain auth.json.');
  const previousAuth = readAuthSummary(root);
  const restoredAuth = readAuthSummaryFromPath(src);
  const safety = createCodexStateBackup(root, { reason: 'pre-backup-restore', includeSubagents: true });
  const restored = [];
  const skipped = [];
  copyRestoredFile(src, path.join(root, 'auth.json'), restored, skipped);
  return {
    backup: backup.path,
    safetyBackup: safety.backup,
    restored: restored.length,
    skipped,
    previousAuth,
    restoredAuth,
  };
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

function updateJsonlFiles(root, candidateRows, targetProvider) {
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
        fs.writeFileSync(file, output, 'utf8');
        changed.push(file);
      } catch (error) {
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
  return withDatabase(root, false, (db) => {
    runImmediateTransaction(db, () => {
      db.prepare("update threads set thread_source='user' where (thread_source is null or thread_source='') and source='vscode';").run();
    });
    checkpoint(db);
    const candidates = getCandidateRows(db, Boolean(includeSubagents), oldProviders || []);
    const jsonl = updateJsonlFiles(root, candidates, targetProvider);
    if (candidates.length) {
      const updateProvider = db.prepare('update threads set model_provider=? where id=?;');
      runImmediateTransaction(db, () => {
        for (const row of candidates) updateProvider.run(targetProvider, row.id);
      });
      checkpoint(db);
    }
    const indexLines = rebuildSessionIndex(db, root);
    const workspaceHintsAdded = updateWorkspaceHints(db, root);
    const config = updateConfigModelProvider(root, targetProvider);
    const verify = verifyRestore(db, root);
    const passed = verify.INDEX_BAD === 0 && verify.null_thread_source === 0 && verify.USER_THREADS_MISSING_HINT === 0 && verify.JSONL_USER_MISMATCH === 0 && verify.JSONL_BAD === 0;
    return { backup: backup.backup, backupSkipped: backup.skipped, config, jsonlChanged: jsonl.changed.length, jsonlSkipped: jsonl.skipped, indexLines, workspaceHintsAdded, verify, passed };
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function normalizeError(error) {
  return { message: error?.message || String(error), stack: error?.stack || '' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res) {
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (req.url === '/api/defaults') return sendJson(res, 200, { ok: true, data: getDefaults() });
    if (req.url === '/api/backups') return sendJson(res, 200, { ok: true, data: listBackups(body) });
    if (req.url === '/api/scan') return sendJson(res, 200, { ok: true, data: scanState(body) });
    if (req.url === '/api/plan') return sendJson(res, 200, { ok: true, data: buildPlan(body) });
    if (req.url === '/api/apply') return sendJson(res, 200, { ok: true, data: applyRestore(body) });
    if (req.url === '/api/restore-backup') return sendJson(res, 200, { ok: true, data: restoreSettingsFromBackup(body) });
    if (req.url === '/api/restore-auth-backup') return sendJson(res, 200, { ok: true, data: restoreAuthFromBackup(body) });
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

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(DIST, rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const fallback = path.join(DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': mime['.html'] });
    res.end(fs.readFileSync(fallback));
    return;
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

function ensureBuiltFrontend() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('Missing dist/index.html. Run: npm run build');
  }
}

function createHttpServer() {
  return http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/')) return handleApi(req, res);
    return serveStatic(req, res);
  });
}

function createServer(port = 47321, options = {}) {
  const host = options.host || '127.0.0.1';
  const startPort = Number(port) || 47321;
  const maxPort = startPort + 100;
  const shouldOpenBrowser = options.openBrowser !== false && process.env.NO_OPEN !== '1';
  const shouldLog = options.log !== false;
  const mode = options.mode || 'browser';

  ensureBuiltFrontend();

  return new Promise((resolve, reject) => {
    const listen = (nextPort) => {
      const server = createHttpServer();
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
};
