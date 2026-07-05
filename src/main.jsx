import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArchiveRestore,
  Loader2,
  ShieldCheck,
  Sparkles,
  Activity,
  Cpu
} from 'lucide-react';
import './styles.css';

async function postJson(url, payload = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}

const browserApi = {
  getDefaults: () => postJson('/api/defaults'),
  selectFolder: async () => window.prompt('请输入 Codex root 路径，例如 C:\\Users\\你\\.codex') || null,
  backups: (payload) => postJson('/api/backups', payload),
  scan: (payload) => postJson('/api/scan', payload),
  plan: (payload) => postJson('/api/plan', payload),
  apply: (payload) => postJson('/api/apply', payload),
  restoreBackup: (payload) => postJson('/api/restore-backup', payload),
};

const api = window.historyRecovery ?? browserApi;

function now() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

function Stat({ label, value, tone = 'slate' }) {
  const tones = {
    slate: 'bg-white text-slate-700 ring-slate-200/50 shadow-sm',
    blue: 'bg-blue-50/80 text-blue-700 ring-blue-100 shadow-sm',
    green: 'bg-emerald-50/80 text-emerald-700 ring-emerald-100 shadow-sm',
    amber: 'bg-amber-50/80 text-amber-700 ring-amber-100 shadow-sm',
    red: 'bg-rose-50/80 text-rose-700 ring-rose-100 shadow-sm',
  };
  return (
    <div className={cx('rounded-2xl px-5 py-4 ring-1 transition-all hover:shadow-md hover:-translate-y-0.5', tones[tone])}>
      <div className="flex items-center gap-2 mb-1.5">
        <div className={cx("w-1.5 h-1.5 rounded-full", 
          tone === 'green' ? 'bg-emerald-500 animate-pulse-slow' : 
          tone === 'red' ? 'bg-rose-500' : 
          tone === 'blue' ? 'bg-blue-500' : 'bg-slate-400'
        )} />
        <div className="text-[11px] font-bold opacity-60 tracking-wider uppercase">{label}</div>
      </div>
      <div className="text-3xl font-bold tracking-tight">{value ?? '-'}</div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="block group">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <span className="text-[13px] font-semibold text-slate-700 group-hover:text-blue-600 transition-colors">{label}</span>
        {hint && <span className="truncate text-[10px] font-semibold tracking-wider text-blue-600 bg-blue-100/50 px-2.5 py-0.5 rounded-full border border-blue-200">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function Button({ children, tone = 'default', busy, className, disabled, ...props }) {
  const tones = {
    default: 'bg-white text-slate-700 ring-1 ring-slate-200 shadow-sm hover:bg-slate-50 hover:shadow',
    primary: 'bg-blue-600 text-white shadow-[0_2px_10px_rgba(37,99,235,0.2)] hover:bg-blue-700 hover:shadow-[0_4px_14px_rgba(37,99,235,0.3)] ring-1 ring-blue-600/50',
    soft: 'bg-slate-100/80 text-slate-700 ring-1 ring-slate-200/50 hover:bg-slate-200/80',
    danger: 'bg-rose-600 text-white shadow-[0_2px_10px_rgba(225,29,72,0.2)] hover:bg-rose-700 hover:shadow-[0_4px_14px_rgba(225,29,72,0.3)] ring-1 ring-rose-600/50',
  };
  return (
    <button
      className={cx(
        'relative overflow-hidden inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-[13px] font-semibold transition-all duration-200 ease-out outline-none focus:ring-2 focus:ring-blue-500/50 focus:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:grayscale-[0.3]',
        tones[tone],
        className,
      )}
      disabled={disabled || busy}
      {...props}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin absolute" />}
      <span className={cx('flex items-center gap-2 transition-opacity', busy && 'opacity-0')}>
        {children}
      </span>
    </button>
  );
}

function Input(props) {
  return (
    <input
      className="h-10 w-full rounded-xl bg-white/50 backdrop-blur-sm border border-slate-200/80 px-4 text-[13px] text-slate-900 shadow-[inset_0_2px_4px_rgba(0,0,0,0.02)] outline-none transition-all placeholder:text-slate-400 hover:bg-white focus:bg-white focus:border-blue-400 focus:ring-[3px] focus:ring-blue-100"
      {...props}
    />
  );
}

function ProviderTable({ rows }) {
  if (!rows?.length) {
    return (
      <div className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-2xl bg-slate-50/50 border border-dashed border-slate-300 text-sm text-slate-400">
        <Activity className="h-8 w-8 mb-3 opacity-30 text-slate-500" />
        <p>扫描后显示数据图谱</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl bg-white border border-slate-200/80 shadow-sm">
      <div className="grid grid-cols-[minmax(0,1fr)_72px_86px_64px] gap-3 border-b border-slate-100 bg-slate-50 px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-slate-500">
        <div>Provider 分组</div>
        <div className="text-center">归档</div>
        <div className="text-center">来源</div>
        <div className="text-right">数量</div>
      </div>
      <div className="divide-y divide-slate-50 text-[13px]">
        {rows.map((row, index) => {
          const archived = String(row.archived) === '1';
          return (
            <div key={`${row.model_provider}-${index}`} className="grid grid-cols-[minmax(0,1fr)_72px_86px_64px] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-blue-50/50">
              <div className="min-w-0 truncate font-medium text-slate-900" title={row.model_provider}>
                {row.model_provider}
              </div>
              <div className="text-center">
                <span className={cx("inline-flex min-w-8 justify-center rounded-md px-2.5 py-1 text-[11px] font-semibold", archived ? 'bg-slate-100 text-slate-600' : 'bg-emerald-50 text-emerald-700 border border-emerald-100')}>
                  {archived ? '√' : '×'}
                </span>
              </div>
              <div className="text-center">
                <span className="inline-flex justify-center rounded-md border border-purple-100 bg-purple-50 px-2.5 py-1 text-[11px] font-semibold text-purple-700">
                  {String(row.thread_source).replaceAll("'", '')}
                </span>
              </div>
              <div className="text-right font-mono text-[15px] font-bold text-blue-700">
                {row.n}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlanCard({ plan }) {
  if (!plan) {
    return (
      <div className="flex h-full flex-col justify-center rounded-2xl bg-white border border-slate-200/80 p-8 text-sm text-slate-400 text-center shadow-sm">
        <Cpu className="h-10 w-10 mx-auto mb-3 opacity-30 text-slate-500" />
        <p>执行计划将在计算后显示</p>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-blue-50/80 to-indigo-50/30 border border-blue-200/60 p-6 shadow-sm">
      <div className="absolute top-0 right-0 p-4 opacity-[0.04] pointer-events-none">
        <ShieldCheck className="w-32 h-32 text-blue-600" />
      </div>
      
      <div className="mb-6 flex items-center gap-2 text-sm font-bold text-blue-800">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500"></span>
        </span>
        检查通过，随时可执行
      </div>
      
      <div className="grid grid-cols-2 gap-4 relative z-10">
        <Stat label="数据变更" value={plan.jsonlToChange} tone="blue" />
        <Stat label="影响线程" value={plan.threadsToMigrate} tone="slate" />
        <Stat label="文件锁定" value={plan.jsonlLockedDryRun} tone={plan.jsonlLockedDryRun ? 'amber' : 'green'} />
        <Stat label="损坏发现" value={plan.jsonlBadDryRun} tone={plan.jsonlBadDryRun ? 'red' : 'green'} />
      </div>
      
      <div className="mt-6 rounded-xl bg-white/80 border border-white p-4 text-[12px] shadow-sm relative z-10">
        <div className="flex items-start gap-3">
          <div className="font-semibold text-slate-600 w-12 pt-0.5">Target</div>
          <div className="flex-1 px-2.5 py-0.5 bg-blue-100/50 text-blue-800 rounded font-mono font-medium border border-blue-200">{plan.targetProvider}</div>
        </div>
        <div className="flex items-start gap-3 mt-3">
          <div className="font-semibold text-slate-600 w-12 pt-0.5">Origin</div>
          <div className="flex-1 flex flex-wrap gap-1.5">
            {plan.oldProviders?.length ? plan.oldProviders.map(p => (
              <span key={p} className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded border border-slate-200/60 font-mono">
                {p}
              </span>
            )) : <span className="text-slate-400 italic py-0.5 font-medium">仅处理空记录</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [root, setRoot] = useState('');
  const [scan, setScan] = useState(null);
  const [target, setTarget] = useState('');
  const [oldProviders, setOldProviders] = useState([]);
  const [includeSubagents, setIncludeSubagents] = useState(null);
  const [plan, setPlan] = useState(null);
  const [applyResult, setApplyResult] = useState(null);
  const [defaultsInfo, setDefaultsInfo] = useState(null);
  const [backups, setBackups] = useState([]);
  const [selectedBackup, setSelectedBackup] = useState('');
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState({ tone: 'info', text: '系统就绪，等待配置路径' });
  const [logs, setLogs] = useState([{ time: now(), text: 'System ready. Awaiting parameters...' }]);

  const providerOptions = scan?.providers ?? [];
  const latestProvider = scan?.latestUser?.model_provider ?? '';
  const selectedBackupInfo = backups.find((item) => item.path === selectedBackup);
  const rootHint = defaultsInfo?.root === root ? (defaultsInfo.rootExists ? '已自动检测' : '需确认') : root ? '已填写' : '未填写';
  const stateDbReady = Boolean(defaultsInfo?.root === root && defaultsInfo.rootExists);
  const stateDbStatus = stateDbReady ? '已就绪' : root ? '待确认' : '未就绪';

  const payload = useMemo(
    () => ({
      root,
      targetProvider: target.trim(),
      oldProviders,
      includeSubagents: includeSubagents === true,
    }),
    [root, target, oldProviders, includeSubagents],
  );

  function log(text) {
    setLogs((items) => [...items, { time: now(), text }]);
  }

  function warn(text) {
    setStatus({ tone: 'warn', text });
    log(`[WARN] ${text}`);
  }

  function resetPlan() {
    setPlan(null);
    setApplyResult(null);
  }

  async function call(action, fn) {
    setBusy(action);
    try {
      const result = await fn();
      if (!result.ok) throw new Error(result.error?.message || '操作失败');
      return result.data;
    } catch (error) {
      setStatus({ tone: 'error', text: '操作失败' });
      log(`[ERROR] ${error.message}`);
      return null;
    } finally {
      setBusy('');
    }
  }

  async function detectDefaults(showStatus = true) {
    const data = await call('defaults', () => api.getDefaults());
    if (!data) return;
    setDefaultsInfo(data);
    setRoot(data.root || '');
    resetPlan();
    if (data.rootExists) refreshBackups(data.root, false);
    if (showStatus) {
      setStatus({ tone: data.rootExists ? 'good' : 'warn', text: data.rootExists ? '已重新检测目录' : '已检测目录，请确认 Root' });
      log(`Defaults detected: root=${data.root || '(empty)'}, sqliteEngine=${data.sqliteEngine || 'bundled'}`);
    }
  }

  useEffect(() => {
    detectDefaults(false).then(() => {
      log('Defaults detected automatically.');
    });
  }, []);

  function updateRoot(value) {
    setRoot(value);
    setScan(null);
    setTarget('');
    setOldProviders([]);
    setIncludeSubagents(null);
    setBackups([]);
    setSelectedBackup('');
    resetPlan();
  }

  async function browseRoot() {
    const selected = await api.selectFolder();
    if (selected) {
      updateRoot(selected);
      setDefaultsInfo((data) => data ? { ...data, root: selected } : data);
      refreshBackups(selected, false);
    }
  }

  async function refreshBackups(currentRoot = root, showStatus = true) {
    const nextRoot = String(currentRoot || '').trim();
    if (!nextRoot) {
      warn('请先填写 Root Directory');
      return;
    }
    const data = await call('backups', () => api.backups({ root: nextRoot }));
    if (!data) return;
    setBackups(data.backups || []);
    setSelectedBackup((value) => (data.backups || []).some((item) => item.path === value) ? value : data.backups?.[0]?.path || '');
    if (showStatus) {
      setStatus({ tone: data.backups?.length ? 'good' : 'warn', text: data.backups?.length ? '已刷新备份列表' : '没有找到备份' });
      log(`Backups found: ${data.backups?.length || 0}`);
    }
  }

  async function handleScan() {
    setLogs([]);
    setStatus({ tone: 'info', text: '正在扫描本地记录...' });
    log('Scanning Codex state directory...');
    const data = await call('scan', () => api.scan({ root }));
    if (!data) return;
    setScan(data);
    setDefaultsInfo((info) => info ? { ...info, root: data.root || root, rootExists: true, sqliteEngine: data.sqliteEngine || info.sqliteEngine } : { root: data.root || root, rootExists: true, sqliteEngine: data.sqliteEngine });
    setTarget('');
    setOldProviders([]);
    setIncludeSubagents(null);
    resetPlan();
    setStatus({ tone: 'good', text: '扫描完成，请配置参数' });
    log(`Found providers: ${data.providers.join(', ') || '(none)'}`);
    if (data.configModelProvider && data.suggestedTarget && data.configModelProvider !== data.suggestedTarget) {
      log(`[WARN] config.toml=${data.configModelProvider}, suggested target=${data.suggestedTarget}; config will be synced to the confirmed Target Provider during restore.`);
    }
    refreshBackups(data.root || root, false);
  }

  function useLatestProvider() {
    if (!scan) {
      warn('请先点击深度扫描，再使用最新聊天');
      return;
    }
    if (!latestProvider) {
      warn('扫描结果里没有可用的最新用户主聊天');
      return;
    }
    setTarget(latestProvider);
    resetPlan();
    log(`Auto-filled: ${latestProvider}`);
    if (oldProviders.includes(latestProvider)) {
      warn(`"${latestProvider}" 已在 Target Overrides 中，请先取消旧 Provider 选择`);
    }
  }

  function toggleOldProvider(provider) {
    const targetProvider = target.trim();
    const alreadySelected = oldProviders.includes(provider);
    if (targetProvider && provider === targetProvider && !alreadySelected) {
      warn(`"${provider}" 是当前 Target Provider，不能作为要替换的旧 Provider`);
      return;
    }
    setOldProviders((items) =>
      items.includes(provider) ? items.filter((item) => item !== provider) : [...items, provider],
    );
    resetPlan();
    if (targetProvider && provider === targetProvider && alreadySelected) {
      warn(`已从 Target Overrides 中移除 "${provider}"`);
    }
  }

  async function handlePlan() {
    const targetProvider = target.trim();
    if (!scan) {
      warn('请先执行扫描');
      return;
    }
    if (!targetProvider) {
      warn('请先填写 Target Provider');
      return;
    }
    if (includeSubagents === null) {
      warn('请先选择是否包含 Subagents');
      return;
    }
    const conflict = oldProviders.find((provider) => provider === targetProvider);
    if (conflict) {
      warn(`Target Overrides 不能包含 Target Provider "${conflict}"，请取消后再检查方案`);
      return;
    }
    if (!oldProviders.length) {
      const ok = window.confirm('你还没有选择 Target Overrides。\n\n这次只会尝试恢复 provider 为空的线程，不会替换任何旧 Provider。\n\n如果旧聊天属于某个旧 Provider，请先勾选它。仍要继续检查方案吗？');
      if (!ok) {
        warn('已取消检查方案，请选择需要替换的旧 Provider');
        return;
      }
    }
    const data = await call('plan', () => api.plan(payload));
    if (!data) return;
    setPlan(data);
    setApplyResult(null);
    log(`Plan generated: threads=${data.threadsToMigrate}, jsonl=${data.jsonlToChange}`);
    if (data.threadsToMigrate === 0 && data.jsonlToChange === 0) {
      setStatus({ tone: 'warn', text: '没有找到需要恢复的记录' });
      log('[WARN] 未匹配到可恢复记录，请检查 Target Provider 和 Target Overrides 是否选反或选错');
    } else if (data.jsonlLockedDryRun > 0) {
      setStatus({ tone: 'warn', text: '有 JSONL 文件被占用' });
      log(`[WARN] ${data.jsonlLockedDryRun} 个 JSONL 文件可能被 Codex 占用，建议关闭或重启 Codex 后再恢复`);
    } else if (data.jsonlBadDryRun > 0) {
      setStatus({ tone: 'warn', text: '发现异常 JSONL 文件' });
      log(`[WARN] ${data.jsonlBadDryRun} 个 JSONL 文件解析异常，请先确认数据状态`);
    } else {
      setStatus({ tone: 'good', text: '恢复方案已就绪' });
    }
  }

  async function handleApply() {
    if (!plan) return;
    const targetProvider = target.trim();
    const configSync = scan?.configModelProvider && scan.configModelProvider !== targetProvider
      ? `\n配置文件将同步: ${scan.configModelProvider} -> ${targetProvider}`
      : '';
    const yes = window.confirm(`确认开始恢复？\n\n执行前会自动备份 Codex 状态。\nTarget Provider: ${targetProvider}\n需处理线程: ${plan.threadsToMigrate}\n需更新 JSONL: ${plan.jsonlToChange}${configSync}`);
    if (!yes) return;
    setStatus({ tone: 'info', text: '正在写入恢复数据...' });
    const data = await call('apply', () => api.apply(payload));
    if (!data) return;
    setApplyResult(data);
    setStatus({ tone: data.passed ? 'good' : 'warn', text: data.passed ? '恢复完成' : '恢复完成，有警告' });
    log(`Backup created: ${data.backup}`);
    if (data.config?.changed) log(`Config synced: ${data.config.previous || '(empty)'} -> ${data.config.current}`);
    else log(`Config already matches: ${data.config?.current || targetProvider}`);
    log(`Commit complete: JSONL=${data.jsonlChanged}, Index=${data.indexLines}`);
    refreshBackups(root, false);
  }

  async function handleRestoreBackup() {
    if (!selectedBackup) {
      warn('请先选择一个备份');
      return;
    }
    const label = selectedBackupInfo?.name || selectedBackup;
    const yes = window.confirm(`确认从这个备份恢复？\n\n${label}\n\n工具会先备份当前状态，然后把所选备份写回 Codex 状态目录。建议先关闭或重启 Codex 桌面端，避免文件被占用。`);
    if (!yes) return;
    setStatus({ tone: 'info', text: '正在恢复备份...' });
    const data = await call('restore-backup', () => api.restoreBackup({ root, backupPath: selectedBackup }));
    if (!data) return;
    setScan(null);
    resetPlan();
    setStatus({ tone: data.skipped?.length ? 'warn' : 'good', text: data.skipped?.length ? '备份已恢复，有文件跳过' : '备份已恢复' });
    log(`Backup restored: ${data.backup}`);
    log(`Safety backup created: ${data.safetyBackup}`);
    log(`Restore complete: files=${data.restored}, skipped=${data.skipped?.length || 0}`);
    refreshBackups(root, false);
  }

  const statusColors = {
    info: 'text-blue-700 bg-blue-50 ring-blue-200/50',
    good: 'text-emerald-700 bg-emerald-50 ring-emerald-200/50',
    warn: 'text-amber-700 bg-amber-50 ring-amber-200/50',
    error: 'text-rose-700 bg-rose-50 ring-rose-200/50',
  }[status.tone];

  return (
    <div className="min-h-screen flex flex-col relative z-10 selection:bg-blue-100">
      <header className="sticky top-0 z-50 border-b border-slate-200/60 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white ring-1 ring-slate-200 text-slate-800 shadow-sm">
              <ArchiveRestore className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-slate-900">Codex Recovery Console</h1>
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mt-0.5">Data Migration Tool</p>
            </div>
          </div>
          <div className={cx('flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider ring-1', statusColors)}>
            <div className={cx("w-1.5 h-1.5 rounded-full", busy ? 'bg-current animate-ping' : 'bg-current')} />
            {status.text}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 sm:px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          <div className="lg:col-span-5 flex flex-col gap-6 lg:sticky lg:top-[90px]">
            <div className="rounded-2xl bg-white/70 backdrop-blur-xl p-6 ring-1 ring-slate-200/60 shadow-glass hover:shadow-glass-hover transition-all relative overflow-hidden">
              <div className="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-blue-300 via-indigo-300 to-purple-300"></div>
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-[16px] font-bold text-slate-900">环境映射</h2>
                <Button tone="soft" onClick={() => detectDefaults(true)} busy={busy === 'defaults'} className="h-9 px-3 text-[12px]">重新检测目录</Button>
              </div>
              <div className="space-y-5">
                <Field label="Root Directory" hint={rootHint}>
                  <div className="flex gap-2">
                    <Input value={root} onChange={(e) => updateRoot(e.target.value)} />
                    <Button onClick={browseRoot} className="shrink-0 min-w-[72px] px-3">更改</Button>
                  </div>
                </Field>
                <div className={cx('rounded-xl border px-4 py-3 text-[12px] font-semibold', stateDbReady ? 'border-emerald-100 bg-emerald-50/70 text-emerald-700' : 'border-amber-100 bg-amber-50/70 text-amber-700')}>
                  <div className="flex items-center justify-between gap-3">
                    <span>状态数据库</span>
                    <span className={cx('rounded-full border bg-white/70 px-2.5 py-0.5 text-[10px] tracking-wider', stateDbReady ? 'border-emerald-200 text-emerald-700' : 'border-amber-200 text-amber-700')}>{stateDbStatus}</span>
                  </div>
                </div>
                <div className="flex gap-3 pt-2">
                  <Button onClick={handleScan} tone="primary" className="flex-1">深度扫描</Button>
                </div>
              </div>
            </div>

            <div className="rounded-2xl bg-white/70 backdrop-blur-xl p-6 ring-1 ring-slate-200/60 shadow-glass hover:shadow-glass-hover transition-all relative">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-[16px] font-bold text-slate-900">迁移策略</h2>
                <Sparkles className="h-4 w-4 text-amber-500" />
              </div>
              <div className="space-y-6">
                <Field label="Target Injection (目标 Provider)">
                  <div className="flex gap-2">
                    <input list="provider-options" value={target} onChange={(e) => setTarget(e.target.value)} className="h-10 min-w-0 flex-1 rounded-xl bg-white border border-slate-200/80 px-4 text-[13px] text-slate-900 shadow-sm outline-none focus:border-blue-400 focus:ring-[3px] focus:ring-blue-100 transition-all" />
                    <datalist id="provider-options">{providerOptions.map((p) => <option value={p} key={p} />)}</datalist>
                    <Button tone="soft" onClick={useLatestProvider} disabled={!scan} className="shrink-0 px-3">使用最新聊天</Button>
                  </div>
                  <div className="mt-2 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2 text-[12px] leading-5 text-slate-600">
                    <span className="font-semibold text-blue-700">提示：</span>
                    如果你使用 GPT/ChatGPT 账号登录，Target Provider 通常是 <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-blue-700">openai</code>。如果暂时无法新建或发送聊天，可以先把 <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-blue-700">openai</code> 作为候选值，只点击“检查方案”验证匹配结果；确认无误后再开始恢复。开始恢复时，工具会把 config.toml 同步为该 Target Provider。
                  </div>
                </Field>

                <Field label="Include Subagents (包含子代理)">
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => { setIncludeSubagents(true); resetPlan(); }} className={cx('rounded-xl ring-1 px-3 py-2 text-[12px] font-bold transition-all shadow-sm', includeSubagents === true ? 'bg-blue-50 text-blue-700 ring-blue-300' : 'bg-white text-slate-500 ring-slate-200 hover:text-slate-700 hover:bg-slate-50')}>TRUE (是)</button>
                    <button onClick={() => { setIncludeSubagents(false); resetPlan(); }} className={cx('rounded-xl ring-1 px-3 py-2 text-[12px] font-bold transition-all shadow-sm', includeSubagents === false ? 'bg-slate-800 text-white ring-slate-800' : 'bg-white text-slate-500 ring-slate-200 hover:text-slate-700 hover:bg-slate-50')}>FALSE (否)</button>
                  </div>
                </Field>

                <Field label="Target Overrides (要替换的旧 Provider)" hint="不要选目标 Provider">
                  <div className="min-h-[90px] rounded-xl bg-slate-50/50 border border-slate-200/60 shadow-inner p-3 flex flex-wrap gap-2">
                    {providerOptions.length ? providerOptions.map((p) => {
                      const sel = oldProviders.includes(p);
                      const isTargetProvider = target.trim() && p === target.trim();
                      const hasConflict = sel && isTargetProvider;
                      return <button key={p} onClick={() => toggleOldProvider(p)} title={hasConflict ? '已选为旧 Provider，但它现在是 Target Provider，点击取消' : isTargetProvider ? '这是 Target Provider，不能作为旧 Provider' : ''} className={cx('rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-all border shadow-sm flex items-center gap-1.5', hasConflict ? 'bg-rose-50 border-rose-200 text-rose-700' : isTargetProvider ? 'bg-amber-50 border-amber-200 text-amber-700' : sel ? 'bg-slate-800 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300')}><div className={cx("w-1.5 h-1.5 rounded-full", hasConflict ? "bg-rose-400" : isTargetProvider ? "bg-amber-400" : sel ? "bg-green-400" : "bg-slate-300")}></div>{p}</button>
                    }) : <div className="text-[12px] text-slate-400 m-auto font-medium">请先执行扫描</div>}
                  </div>
                </Field>

                <div className="grid grid-cols-2 gap-3 pt-4 border-t border-slate-100">
                  <Button disabled={!scan} onClick={handlePlan} className="col-span-1">检查方案</Button>
                  <Button tone="primary" disabled={!plan} onClick={handleApply} className="col-span-1">开始恢复</Button>
                </div>
              </div>
            </div>

            <div className="rounded-2xl bg-white/70 backdrop-blur-xl p-6 ring-1 ring-slate-200/60 shadow-glass hover:shadow-glass-hover transition-all relative">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[16px] font-bold text-slate-900">备份回滚</h2>
                  <p className="mt-1 text-[12px] font-medium text-slate-500">从恢复前自动备份中还原 Codex 状态</p>
                </div>
                <Button tone="soft" onClick={() => refreshBackups(root)} busy={busy === 'backups'} className="h-9 px-3 text-[12px]">刷新备份</Button>
              </div>

              <div className="space-y-4">
                <Field label="Backup Snapshot" hint={backups.length ? `${backups.length} 个备份` : '暂无备份'}>
                  <select
                    value={selectedBackup}
                    onChange={(e) => setSelectedBackup(e.target.value)}
                    className="h-10 w-full rounded-xl bg-white border border-slate-200/80 px-4 text-[13px] text-slate-900 shadow-sm outline-none transition-all hover:bg-slate-50 focus:border-blue-400 focus:ring-[3px] focus:ring-blue-100"
                  >
                    {backups.length ? backups.map((item) => (
                      <option key={item.path} value={item.path}>
                        {item.name}
                      </option>
                    )) : <option value="">请先刷新备份列表</option>}
                  </select>
                </Field>

                <div className="rounded-xl border border-slate-200/70 bg-slate-50/70 px-4 py-3 text-[12px] text-slate-600">
                  {selectedBackupInfo ? (
                    <div className="space-y-1.5">
                      <div className="flex justify-between gap-3">
                        <span className="font-semibold text-slate-700">创建时间</span>
                        <span className="text-right">{new Date(selectedBackupInfo.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="font-semibold text-slate-700">目标 Provider</span>
                        <span className="max-w-[220px] truncate font-mono text-slate-800">{selectedBackupInfo.targetProvider || '-'}</span>
                      </div>
                    </div>
                  ) : (
                    <span className="font-medium text-slate-400">选择备份后显示详情</span>
                  )}
                </div>

                <Button tone="danger" disabled={!selectedBackup} busy={busy === 'restore-backup'} onClick={handleRestoreBackup} className="w-full">
                  恢复此备份
                </Button>
              </div>
            </div>
          </div>

          <div className="lg:col-span-7 flex flex-col gap-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Stat label="Total" value={scan?.providers?.length ?? 0} />
              <Stat label="Threads" value={plan?.threadsToMigrate ?? '-'} tone="blue" />
              <Stat label="JSONL" value={plan?.jsonlToChange ?? '-'} tone="amber" />
              <Stat label="Status" value={applyResult ? (applyResult.passed ? 'OK' : 'WARN') : '-'} tone={applyResult?.passed ? 'green' : applyResult ? 'red' : 'slate'} />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div className="flex flex-col h-full"><ProviderTable rows={scan?.providerRows} /></div>
              <div className="flex flex-col h-full"><PlanCard plan={plan} /></div>
            </div>

            <div className="mt-2 flex-1 min-h-[300px] overflow-hidden rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl flex flex-col font-mono relative">
              <div className="flex items-center justify-between border-b border-slate-700/50 bg-slate-800/50 px-4 py-3 z-10">
                <div className="flex gap-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-rose-500"></div><div className="h-2.5 w-2.5 rounded-full bg-amber-500"></div><div className="h-2.5 w-2.5 rounded-full bg-emerald-500"></div>
                </div>
                <div className="text-[11px] font-medium text-slate-400 tracking-wider">/VAR/LOG/SYSTEM.LOG</div>
              </div>
              <div className="h-full overflow-y-auto p-4 text-[12px] leading-relaxed z-10">
                {logs.map((item, i) => (
                  <div key={i} className="flex gap-3 hover:bg-slate-800/50 px-2 py-0.5 rounded break-all">
                    <span className="text-slate-500 shrink-0">[{item.time}]</span> 
                    <span className={cx(item.text.includes('ERROR') ? 'text-rose-400' : item.text.includes('WARN') ? 'text-amber-400' : item.text.includes('OK') || item.text.includes('COMPLETE') ? 'text-emerald-400 font-medium' : 'text-slate-300')}>{item.text}</span>
                  </div>
                ))}
                <div className="flex gap-3 px-2 py-0.5 mt-1"><span className="text-slate-500">[{now()}]</span><span className="w-2 h-3.5 bg-slate-400 animate-pulse mt-1"></span></div>
              </div>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
