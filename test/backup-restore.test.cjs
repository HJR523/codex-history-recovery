const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { _internal } = require('../server.cjs');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-recovery-test-'));
  const backup = path.join(root, 'backup-20260720-120000-pre-chat-history-restore');
  fs.mkdirSync(backup, { recursive: true });
  writeJson(path.join(backup, 'manifest.json'), {
    createdAt: '2026-07-20T12:00:00.000Z',
    reason: 'pre-chat-history-restore',
    root,
  });
  fs.writeFileSync(path.join(backup, 'config.toml'), 'model_provider = "snapshot-provider"\n', 'utf8');
  writeJson(path.join(backup, 'auth.json'), { auth_mode: 'chatgpt', tokens: { access_token: 'snapshot-token' } });

  fs.writeFileSync(path.join(root, 'config.toml'), 'model_provider = "current-provider"\n[features]\nflag = true\n', 'utf8');
  writeJson(path.join(root, 'auth.json'), { OPENAI_API_KEY: 'current-key' });
  return { root, backupPath: backup };
}

test('backup content can be inspected and selectively applied', () => {
  const fixture = createFixture();
  try {
    const preview = _internal.readBackupContent(fixture);
    assert.equal(preview.config.modelProvider, 'snapshot-provider');
    assert.match(preview.auth.content, /snapshot-token/);

    const result = _internal.applyBackupContent({
      root: fixture.root,
      authBackupPath: fixture.backupPath,
      applyConfig: true,
      configProvider: 'edited-provider',
      applyAuth: true,
      authJson: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'edited-token' } }),
    });

    assert.match(fs.readFileSync(path.join(fixture.root, 'config.toml'), 'utf8'), /model_provider = "edited-provider"/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.root, 'auth.json'), 'utf8')).tokens.access_token, 'edited-token');
    assert.equal(fs.existsSync(result.safetyBackup), true);

    const duplicate = path.join(fixture.root, 'backup-20260720-120100-manual-auth-snapshot');
    fs.mkdirSync(duplicate, { recursive: true });
    writeJson(path.join(duplicate, 'manifest.json'), {
      createdAt: '2026-07-20T12:01:00.000Z',
      reason: 'manual-auth-snapshot',
      root: fixture.root,
    });
    fs.copyFileSync(path.join(fixture.backupPath, 'auth.json'), path.join(duplicate, 'auth.json'));

    const renamed = _internal.renameBackupAuth({
      ...fixture,
      authDisplayName: '工作账号认证',
    });
    assert.equal(renamed.authDisplayName, '工作账号认证');
    assert.equal(renamed.updated, 2);

    const listed = _internal.listBackups({ root: fixture.root }).backups;
    assert.equal(listed.find((item) => item.path === fixture.backupPath).configModelProvider, 'snapshot-provider');
    assert.equal(listed.filter((item) => item.path === fixture.backupPath || item.path === duplicate).every((item) => item.authDisplayName === '工作账号认证'), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('deleting a selected version backup leaves current state and other backups intact', () => {
  const fixture = createFixture();
  const otherBackup = path.join(fixture.root, 'backup-20260720-120100-manual-auth-snapshot');
  try {
    fs.mkdirSync(otherBackup, { recursive: true });
    writeJson(path.join(otherBackup, 'manifest.json'), {
      createdAt: '2026-07-20T12:01:00.000Z',
      reason: 'manual-auth-snapshot',
      root: fixture.root,
    });
    writeJson(path.join(otherBackup, 'auth.json'), { auth_mode: 'chatgpt', tokens: { access_token: 'other-token' } });

    const deleted = _internal.deleteBackup({ root: fixture.root, backupPath: fixture.backupPath });

    assert.equal(deleted.deleted, fixture.backupPath);
    assert.equal(fs.existsSync(fixture.backupPath), false);
    assert.equal(fs.existsSync(otherBackup), true);
    assert.equal(fs.existsSync(path.join(fixture.root, 'config.toml')), true);
    assert.equal(fs.existsSync(path.join(fixture.root, 'auth.json')), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('config and auth application rolls config back when auth cannot be written', () => {
  const fixture = createFixture();
  const authPath = path.join(fixture.root, 'auth.json');
  const originalConfig = fs.readFileSync(path.join(fixture.root, 'config.toml'), 'utf8');
  const originalAuth = fs.readFileSync(authPath, 'utf8');
  try {
    fs.chmodSync(authPath, 0o444);
    assert.throws(() => _internal.applyBackupContent({
      root: fixture.root,
      authBackupPath: fixture.backupPath,
      applyConfig: true,
      configProvider: 'must-be-rolled-back',
      applyAuth: true,
      authJson: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'never-written' } }),
    }), /EPERM|permission|access/i);
    assert.equal(fs.readFileSync(path.join(fixture.root, 'config.toml'), 'utf8'), originalConfig);
    assert.equal(fs.readFileSync(authPath, 'utf8'), originalAuth);
    assert.equal(fs.readdirSync(fixture.root).some((name) => name.startsWith('.history-mutation-journal-')), false);
  } finally {
    try { fs.chmodSync(authPath, 0o666); } catch {}
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('saving an auth snapshot automatically removes older duplicate auth snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-recovery-auth-test-'));
  try {
    writeJson(path.join(root, 'auth.json'), { auth_mode: 'chatgpt', tokens: { access_token: 'same-token' } });

    const olderDuplicate = path.join(root, 'backup-20260720-110000-manual-auth-snapshot');
    fs.mkdirSync(olderDuplicate, { recursive: true });
    writeJson(path.join(olderDuplicate, 'manifest.json'), {
      createdAt: '2026-07-20T11:00:00.000Z',
      reason: 'manual-auth-snapshot',
      root,
    });
    fs.copyFileSync(path.join(root, 'auth.json'), path.join(olderDuplicate, 'auth.json'));

    const regularBackup = path.join(root, 'backup-20260720-100000-pre-chat-history-restore');
    fs.mkdirSync(regularBackup, { recursive: true });
    writeJson(path.join(regularBackup, 'manifest.json'), {
      createdAt: '2026-07-20T10:00:00.000Z',
      reason: 'pre-chat-history-restore',
      root,
    });
    fs.copyFileSync(path.join(root, 'auth.json'), path.join(regularBackup, 'auth.json'));

    const saved = _internal.createAuthSnapshot({ root, authDisplayName: '当前账号' });

    assert.equal(fs.existsSync(saved.backup), true);
    assert.equal(fs.existsSync(olderDuplicate), false);
    assert.equal(fs.existsSync(regularBackup), true);
    assert.deepEqual(saved.cleanup.deleted, [olderDuplicate]);
    assert.equal(saved.authDisplayName, '当前账号');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('auth display name updates are all-or-none when a duplicate manifest is not writable', () => {
  const fixture = createFixture();
  const duplicate = path.join(fixture.root, 'backup-20260720-120100-manual-auth-snapshot');
  const duplicateManifest = path.join(duplicate, 'manifest.json');
  try {
    fs.mkdirSync(duplicate, { recursive: true });
    writeJson(duplicateManifest, {
      createdAt: '2026-07-20T12:01:00.000Z',
      reason: 'manual-auth-snapshot',
      root: fixture.root,
    });
    fs.copyFileSync(path.join(fixture.backupPath, 'auth.json'), path.join(duplicate, 'auth.json'));
    fs.chmodSync(duplicateManifest, 0o444);

    assert.throws(() => _internal.renameBackupAuth({
      ...fixture,
      authDisplayName: '不应部分保存',
    }), /EPERM|permission|access/i);

    const originalManifest = JSON.parse(fs.readFileSync(path.join(fixture.backupPath, 'manifest.json'), 'utf8'));
    assert.equal(originalManifest.authDisplayName, undefined);
  } finally {
    try { fs.chmodSync(duplicateManifest, 0o666); } catch {}
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('incomplete safety backups fail closed and remove the partial backup', () => {
  const root = createMigrationFixture('history-recovery-backup-failure-');
  try {
    fs.mkdirSync(path.join(root, 'session_index.jsonl'));
    assert.throws(
      () => _internal.createCodexStateBackup(root, { reason: 'pre-chat-history-import' }),
      /Safety backup is incomplete/i,
    );
    assert.equal(fs.readdirSync(root).some((name) => name.includes('pre-chat-history-import')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('localhost API authorization rejects cross-origin and non-JSON writes', () => {
  const token = 'a'.repeat(64);
  const request = {
    method: 'POST',
    headers: {
      host: '127.0.0.1:47321',
      origin: 'http://127.0.0.1:47321',
      cookie: `history_recovery_token=${token}`,
      'content-type': 'application/json',
    },
  };
  assert.equal(_internal.isAuthorizedApiRequest(request, token), true);
  assert.equal(_internal.isAuthorizedApiRequest({ ...request, headers: { ...request.headers, origin: 'https://example.com' } }, token), false);
  assert.equal(_internal.isAuthorizedApiRequest({ ...request, headers: { ...request.headers, 'content-type': 'text/plain' } }, token), false);
  assert.equal(_internal.isAuthorizedApiRequest({ ...request, headers: { ...request.headers, cookie: '' } }, token), false);
});

function createMigrationFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  try {
    db.exec(`
      create table threads (
        id text primary key,
        title text,
        first_user_message text,
        model_provider text,
        thread_source text not null,
        source text,
        archived integer,
        cwd text,
        updated_at integer,
        updated_at_ms integer
      );
    `);
  } finally {
    db.close();
  }
  return root;
}

function seedMigrationThread(root, {
  id,
  title,
  provider = 'source-provider',
  cwd = 'D:\\old-workspace\\project',
  updatedAtMs = 1_783_000_000_000,
}) {
  const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  try {
    db.prepare(`
      insert into threads (id, title, first_user_message, model_provider, thread_source, source, archived, cwd, updated_at, updated_at_ms)
      values (?, ?, ?, ?, 'user', 'cli', 0, ?, ?, ?);
    `).run(id, title, title, provider, cwd, Math.floor(updatedAtMs / 1000), updatedAtMs);
  } finally {
    db.close();
  }

  const sessionFile = path.join(root, 'sessions', '2026', '07', '20', `rollout-${id}.jsonl`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const jsonl = [
    JSON.stringify({ type: 'session_meta', payload: { id, model_provider: provider, cwd } }),
    JSON.stringify({ type: 'message', payload: { text: title } }),
    '',
  ].join('\n');
  fs.writeFileSync(sessionFile, jsonl, 'utf8');
  return sessionFile;
}

function readMigrationThread(root, id) {
  const db = new DatabaseSync(path.join(root, 'state_5.sqlite'), { readOnly: true });
  try {
    return db.prepare('select * from threads where id=?;').get(id);
  } finally {
    db.close();
  }
}

test('selected chats export and import as a safe migration package', async () => {
  const source = createMigrationFixture('history-recovery-export-source-');
  const target = createMigrationFixture('history-recovery-export-target-');
  const selectedId = '11111111-1111-4111-8111-111111111111';
  const unselectedId = '22222222-2222-4222-8222-222222222222';
  try {
    seedMigrationThread(source, { id: selectedId, title: '要迁移的聊天' });
    seedMigrationThread(source, { id: unselectedId, title: '不应迁移的聊天' });
    fs.writeFileSync(path.join(target, 'auth.json'), JSON.stringify({ keep: 'target-secret' }), 'utf8');
    fs.writeFileSync(path.join(target, 'config.toml'), 'model_provider = "target-config-provider"\n', 'utf8');

    const listed = _internal.listTransferThreads({ root: source });
    assert.equal(listed.threads.length, 2);
    assert.equal(listed.threads.every((thread) => thread.exportable), true);

    const packagePath = path.join(source, 'selected-chats.codex-history');
    const exported = await _internal.exportHistoryTransfer({
      root: source,
      threadIds: [selectedId],
      outputPath: packagePath,
    });
    assert.equal(exported.exported, 1);
    assert.equal(exported.requested, 1);
    assert.equal(fs.existsSync(packagePath), true);

    const preview = await _internal.inspectHistoryTransfer({ root: target, packagePath });
    assert.equal(preview.schemaCompatible, true);
    assert.equal(preview.total, 1);
    assert.equal(preview.threads[0].id, selectedId);
    assert.equal(preview.threads[0].status, 'new');

    const imported = await _internal.importHistoryTransfer({
      root: target,
      packagePath,
      threadIds: [selectedId],
      targetProvider: 'target-provider',
      workspacePathFrom: 'D:\\old-workspace',
      workspacePathTo: 'E:\\new-workspace',
    });
    assert.equal(imported.imported.length, 1);
    assert.equal(imported.jsonlImported, 1);
    assert.equal(imported.passed, true);
    assert.equal(fs.existsSync(imported.backup), true);

    const row = readMigrationThread(target, selectedId);
    assert.equal(row.model_provider, 'target-provider');
    assert.equal(row.cwd, 'E:\\new-workspace\\project');
    assert.equal(readMigrationThread(target, unselectedId), undefined);

    const sessionFile = path.join(target, 'sessions', '2026', '07', '20', `rollout-${selectedId}.jsonl`);
    const meta = JSON.parse(fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/, 1)[0]);
    assert.equal(meta.payload.model_provider, 'target-provider');
    assert.equal(meta.payload.cwd, 'E:\\new-workspace\\project');

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'auth.json'), 'utf8')), { keep: 'target-secret' });
    assert.equal(fs.readFileSync(path.join(target, 'config.toml'), 'utf8'), 'model_provider = "target-config-provider"\n');
    assert.match(fs.readFileSync(path.join(target, 'session_index.jsonl'), 'utf8'), new RegExp(selectedId));
    const globalState = JSON.parse(fs.readFileSync(path.join(target, '.codex-global-state.json'), 'utf8'));
    assert.equal(globalState['thread-workspace-root-hints'][selectedId], 'E:\\new-workspace\\project');
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('migration import does not overwrite a conflicting chat ID', async () => {
  const source = createMigrationFixture('history-recovery-conflict-source-');
  const target = createMigrationFixture('history-recovery-conflict-target-');
  const id = '33333333-3333-4333-8333-333333333333';
  try {
    seedMigrationThread(source, { id, title: '源端内容', provider: 'source-provider' });
    seedMigrationThread(target, { id, title: '目标端保留内容', provider: 'target-provider' });
    const packagePath = path.join(source, 'conflict.codex-history');
    await _internal.exportHistoryTransfer({ root: source, threadIds: [id], outputPath: packagePath });

    const preview = await _internal.inspectHistoryTransfer({ root: target, packagePath });
    assert.equal(preview.threads[0].status, 'conflict');
    assert.equal(preview.threads[0].canImport, false);

    const imported = await _internal.importHistoryTransfer({ root: target, packagePath, threadIds: [id] });
    assert.equal(imported.imported.length, 0);
    assert.equal(imported.skipped.length, 1);
    assert.equal(imported.backup, '');
    assert.equal(readMigrationThread(target, id).title, '目标端保留内容');
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('migration import removes partially moved files and database rows after a move failure', async () => {
  const source = createMigrationFixture('history-recovery-partial-source-');
  const target = createMigrationFixture('history-recovery-partial-target-');
  const id = '44444444-4444-4444-8444-444444444444';
  try {
    const firstSession = seedMigrationThread(source, { id, title: '需要完整回滚的聊天' });
    const blockedSession = path.join(source, 'sessions', 'blocked', 'child', `rollout-extra-${id}.jsonl`);
    fs.mkdirSync(path.dirname(blockedSession), { recursive: true });
    fs.copyFileSync(firstSession, blockedSession);
    const packagePath = path.join(source, 'partial-failure.codex-history');
    await _internal.exportHistoryTransfer({ root: source, threadIds: [id], outputPath: packagePath });

    fs.mkdirSync(path.join(target, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(target, 'sessions', 'blocked'), 'prevents child directory creation', 'utf8');

    await assert.rejects(
      _internal.importHistoryTransfer({ root: target, packagePath, threadIds: [id] }),
      /ENOTDIR|directory/i,
    );
    assert.equal(readMigrationThread(target, id), undefined);
    assert.equal(fs.existsSync(path.join(target, 'sessions', '2026', '07', '20', `rollout-${id}.jsonl`)), false);
    assert.equal(fs.readdirSync(target).some((name) => name.startsWith('.history-import-staging-')), false);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('provider restore rolls database and files back when a JSONL cannot be written', () => {
  const root = createMigrationFixture('history-recovery-restore-rollback-');
  const id = '55555555-5555-4555-8555-555555555555';
  let sessionFile = '';
  try {
    sessionFile = seedMigrationThread(root, { id, title: '恢复失败必须回滚', provider: 'old-provider' });
    const originalJsonl = fs.readFileSync(sessionFile, 'utf8');
    fs.chmodSync(sessionFile, 0o444);

    assert.throws(() => _internal.applyRestore({
      root,
      targetProvider: 'new-provider',
      oldProviders: ['old-provider'],
      includeSubagents: false,
    }), /EPERM|permission|access/i);

    assert.equal(readMigrationThread(root, id).model_provider, 'old-provider');
    assert.equal(fs.readFileSync(sessionFile, 'utf8'), originalJsonl);
    assert.equal(fs.existsSync(path.join(root, 'config.toml')), false);
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith('.history-mutation-journal-')), false);
  } finally {
    try { if (sessionFile) fs.chmodSync(sessionFile, 0o666); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration destinations cannot cross a nested linked directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-recovery-link-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'history-recovery-link-outside-'));
  try {
    const sessions = path.join(root, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(sessions, 'linked'), 'junction');
    } catch (error) {
      if (error.code === 'EPERM') {
        t.skip('Creating a junction is not permitted in this environment.');
        return;
      }
      throw error;
    }
    assert.throws(
      () => _internal.getHistoryTransferDestination(root, 'sessions', 'linked/rollout-test.jsonl'),
      /linked directory outside/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
