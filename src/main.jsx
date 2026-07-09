import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArchiveRestore,
  Loader2,
  ShieldCheck,
  Sparkles,
  Activity,
  Cpu,
  Database,
  FolderSearch,
  Gauge,
  ListChecks,
  RotateCcw,
  TerminalSquare,
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
  restoreAuthBackup: (payload) => postJson('/api/restore-auth-backup', payload),
  deleteBackup: (payload) => postJson('/api/delete-backup', payload),
  cleanupBackups: (payload) => postJson('/api/cleanup-backups', payload),
};

const api = window.historyRecovery ?? browserApi;

function now() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

function joinDisplayPath(base, file) {
  const cleanBase = String(base || '').replace(/[\\/]+$/, '');
  return cleanBase ? `${cleanBase}\\${file}` : file;
}

function authStatusMeta(auth) {
  if (!auth) {
    return {
      label: '待扫描',
      tone: 'slate',
      description: '扫描后读取当前 auth.json，不显示密钥内容。',
    };
  }
  if (!auth.exists) {
    return {
      label: '未找到 auth.json',
      tone: 'amber',
      description: '当前目录没有认证文件。恢复聊天记录不会自动生成登录态。',
    };
  }
  if (!auth.readable) {
    return {
      label: '无法读取 auth.json',
      tone: 'red',
      description: auth.error || '认证文件存在，但无法解析。',
    };
  }
  if (auth.authType === 'api_key') {
    return {
      label: 'API Key 模式',
      tone: 'amber',
      description: '当前认证更像 API Key 模式，不等于 GPT/ChatGPT 账号登录。',
    };
  }
  if (auth.authType === 'account') {
    return {
      label: '账号登录态可能存在',
      tone: 'green',
      description: '检测到账号登录相关信号。工具只展示摘要，不显示 token。',
    };
  }
  return {
    label: auth.authMode ? `未知模式 (${auth.authMode})` : '未知认证模式',
    tone: 'amber',
    description: '工具无法确定它是不是 GPT/ChatGPT 账号登录态，请以 Codex 实际能否发消息为准。',
  };
}

function authToneClass(tone) {
  const tones = {
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    red: 'border-rose-200 bg-rose-50 text-rose-700',
  };
  return tones[tone] || tones.slate;
}

function authWarningForTarget(targetProvider, auth) {
  if (String(targetProvider || '').trim().toLowerCase() !== 'openai' || !auth) return '';
  if (!auth.exists) {
    return 'Target Provider 是 openai，但当前目录没有 auth.json；这不会恢复 GPT/ChatGPT 账号登录，可能仍然无法发送消息。请先在 Codex 中重新登录账号，或从含账号登录态的备份恢复 auth.json。';
  }
  if (auth.authType === 'api_key') {
    return 'Target Provider 是 openai，但当前 auth.json 是 API Key 模式；这不会恢复 GPT/ChatGPT 账号登录，可能仍然无法发送消息。请先在 Codex 中重新登录账号，或从含账号登录态的备份恢复 auth.json。';
  }
  if (auth.authType === 'unknown' || auth.authType === 'unreadable') {
    return 'Target Provider 是 openai，但工具无法确认当前 auth.json 是否为 GPT/ChatGPT 账号登录态。恢复聊天记录可以继续，但登录态需要以 Codex 实际能否发消息为准。';
  }
  return '';
}

const panelClass = 'rounded-lg border border-white/80 bg-white/[0.88] p-5 shadow-soft ring-1 ring-slate-950/[0.03] backdrop-blur-xl sm:p-6';
const inputClass = 'h-11 w-full rounded-lg border border-slate-200 bg-white px-3.5 text-[13px] text-slate-900 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] outline-none transition duration-200 placeholder:text-slate-400 hover:border-slate-300 focus:border-orange-400 focus:ring-4 focus:ring-orange-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';

function SectionHeader({ icon: Icon, title, eyebrow, action, accent = 'orange' }) {
  const accents = {
    orange: 'bg-orange-50 text-orange-700 ring-orange-100',
    blue: 'bg-blue-50 text-blue-700 ring-blue-100',
    slate: 'bg-slate-100 text-slate-700 ring-slate-200',
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
  };
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {Icon && (
          <div className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1', accents[accent])}>
            <Icon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0">
          {eyebrow && <div className="text-[11px] font-semibold uppercase text-slate-400">{eyebrow}</div>}
          <h2 className="truncate text-[16px] font-semibold text-slate-950">{title}</h2>
        </div>
      </div>
      {action}
    </div>
  );
}

function Panel({ children, className }) {
  return <section className={cx(panelClass, className)}>{children}</section>;
}

function StatusPill({ tone = 'info', children, busy }) {
  const tones = {
    info: 'border-blue-200 bg-blue-50 text-blue-700',
    good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    warn: 'border-amber-200 bg-amber-50 text-amber-800',
    error: 'border-rose-200 bg-rose-50 text-rose-700',
  };
  return (
    <div className={cx('inline-flex min-h-8 max-w-full items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-semibold', tones[tone])}>
      <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full bg-current', busy && 'animate-ping')} />
      <span className="truncate">{children}</span>
    </div>
  );
}

function Stat({ label, value, tone = 'slate' }) {
  const tones = {
    slate: 'border-slate-200 bg-white text-slate-700',
    blue: 'border-blue-200 bg-blue-50/80 text-blue-700',
    green: 'border-emerald-200 bg-emerald-50/80 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50/80 text-amber-800',
    red: 'border-rose-200 bg-rose-50/80 text-rose-700',
  };
  return (
    <div className={cx('rounded-lg border px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]', tones[tone])}>
      <div className="mb-1.5 flex items-center gap-2">
        <div className={cx("w-1.5 h-1.5 rounded-full", 
          tone === 'green' ? 'bg-emerald-500 animate-pulse-slow' : 
          tone === 'red' ? 'bg-rose-500' : 
          tone === 'blue' ? 'bg-blue-500' : 'bg-slate-400'
        )} />
        <div className="text-[11px] font-semibold uppercase text-current opacity-65">{label}</div>
      </div>
      <div className="text-2xl font-semibold tabular-nums tracking-tight">{value ?? '-'}</div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="block group">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[13px] font-semibold text-slate-700 transition-colors group-hover:text-orange-700">{label}</span>
        {hint && <span className="truncate rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function Button({ children, tone = 'default', busy, className, disabled, ...props }) {
  const tones = {
    default: 'border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50',
    primary: 'border border-orange-600 bg-orange-600 text-white shadow-[0_10px_20px_-12px_rgba(234,88,12,0.75)] hover:bg-orange-700',
    accent: 'border border-blue-600 bg-blue-600 text-white shadow-[0_10px_20px_-12px_rgba(37,99,235,0.75)] hover:bg-blue-700',
    soft: 'border border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-white',
    danger: 'border border-rose-600 bg-rose-600 text-white shadow-[0_10px_20px_-12px_rgba(225,29,72,0.75)] hover:bg-rose-700',
  };
  return (
    <button
      className={cx(
        'relative inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-[13px] font-semibold outline-none transition duration-200 ease-out active:scale-[0.98] focus-visible:ring-4 focus-visible:ring-orange-100',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:grayscale-[0.2] disabled:active:scale-100',
        tones[tone],
        className,
      )}
      type={props.type ?? 'button'}
      disabled={disabled || busy}
      {...props}
    >
      {busy && <Loader2 className="absolute h-4 w-4 animate-spin" />}
      <span className={cx('flex items-center gap-2 transition-opacity', busy && 'opacity-0')}>
        {children}
      </span>
    </button>
  );
}

function Input(props) {
  return (
    <input
      className={inputClass}
      {...props}
    />
  );
}

function ProviderTable({ rows }) {
  const tableGridClass = 'grid grid-cols-[minmax(0,1fr)_54px_72px_46px] gap-2 sm:grid-cols-[minmax(0,1fr)_64px_84px_56px] sm:gap-3';

  if (!rows?.length) {
    return (
      <div className="flex min-h-[176px] flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-6 text-center text-sm text-slate-500 sm:min-h-[190px]">
        <Activity className="mb-3 h-8 w-8 text-slate-400" />
        <p className="font-medium">扫描后显示 Provider 分布</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className={cx(tableGridClass, 'border-b border-slate-200 bg-slate-50 px-3 py-3 text-[11px] font-semibold uppercase text-slate-500 sm:px-4')}>
        <div>Provider 分组</div>
        <div className="text-center">归档</div>
        <div className="text-center">来源</div>
        <div className="text-right">数量</div>
      </div>
      <div className="divide-y divide-slate-100 text-[13px]">
        {rows.map((row, index) => {
          const archived = String(row.archived) === '1';
          return (
            <div key={`${row.model_provider}-${index}`} className={cx(tableGridClass, 'items-center px-3 py-3.5 transition-colors hover:bg-orange-50/45 sm:px-4')}>
              <div className="min-w-0 break-all font-medium leading-5 text-slate-900" title={row.model_provider}>
                {row.model_provider}
              </div>
              <div className="text-center">
                <span className={cx("inline-flex min-w-8 justify-center rounded-md border px-2 py-1 text-[11px] font-semibold", archived ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-600')}>
                  {archived ? '√' : '×'}
                </span>
              </div>
              <div className="text-center">
                <span className="inline-flex max-w-full justify-center rounded-md border border-blue-100 bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700">
                  {String(row.thread_source).replaceAll("'", '')}
                </span>
              </div>
              <div className="text-right font-mono text-[15px] font-semibold text-orange-700">
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
      <div className="flex min-h-[176px] flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-6 text-center text-sm text-slate-500 sm:min-h-[190px]">
        <Cpu className="mb-3 h-9 w-9 text-slate-400" />
        <p className="font-medium">检查方案后显示执行计划</p>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-blue-200/70 bg-gradient-to-br from-blue-50 via-white to-orange-50/60 p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6">
      <div className="pointer-events-none absolute right-3 top-3 text-blue-600 opacity-[0.06]">
        <ShieldCheck className="h-28 w-28" />
      </div>

      <div className="relative z-10 mb-5 flex items-center gap-2 text-sm font-semibold text-blue-800">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
        </span>
        检查通过，随时可执行
      </div>

      <div className="relative z-10 grid grid-cols-2 gap-3">
        <Stat label="数据变更" value={plan.jsonlToChange} tone="blue" />
        <Stat label="影响线程" value={plan.threadsToMigrate} tone="slate" />
        <Stat label="文件锁定" value={plan.jsonlLockedDryRun} tone={plan.jsonlLockedDryRun ? 'amber' : 'green'} />
        <Stat label="损坏发现" value={plan.jsonlBadDryRun} tone={plan.jsonlBadDryRun ? 'red' : 'green'} />
      </div>

      <div className="relative z-10 mt-5 rounded-lg border border-white bg-white/85 p-4 text-[12px] shadow-sm">
        <div className="flex items-start gap-3">
          <div className="w-12 pt-0.5 font-semibold text-slate-600">Target</div>
          <div className="min-w-0 flex-1 rounded-md border border-blue-100 bg-blue-50 px-2.5 py-1 font-mono font-medium text-blue-800">{plan.targetProvider}</div>
        </div>
        <div className="mt-3 flex items-start gap-3">
          <div className="w-12 pt-0.5 font-semibold text-slate-600">Origin</div>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {plan.oldProviders?.length ? plan.oldProviders.map(p => (
              <span key={p} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-slate-700">
                {p}
              </span>
            )) : <span className="py-0.5 font-medium text-slate-400">仅处理空记录</span>}
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
  const [backupKeepCount, setBackupKeepCount] = useState(2);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState({ tone: 'info', text: '系统就绪，等待配置路径' });
  const [logs, setLogs] = useState([{ time: now(), text: 'System ready. Awaiting parameters...' }]);

  const providerOptions = scan?.providers ?? [];
  const configProvider = scan?.configModelProvider ?? '';
  const latestProvider = scan?.latestUser?.model_provider ?? '';
  const selectedBackupInfo = backups.find((item) => item.path === selectedBackup);
  const rootHint = defaultsInfo?.root === root ? (defaultsInfo.rootExists ? '已自动检测' : '需确认') : root ? '已填写' : '未填写';
  const stateDbReady = Boolean(defaultsInfo?.root === root && defaultsInfo.rootExists);
  const stateDbStatus = stateDbReady ? '已就绪' : root ? '待确认' : '未就绪';
  const configTomlPath = root ? joinDisplayPath(root, 'config.toml') : '当前 Codex root\\config.toml';
  const authInfo = scan?.auth ?? null;
  const authMeta = authStatusMeta(authInfo);
  const authPath = root ? joinDisplayPath(root, 'auth.json') : '当前 Codex root\\auth.json';
  const selectedBackupAuthMeta = authStatusMeta(selectedBackupInfo?.auth ?? null);
  const openAiAuthWarning = authWarningForTarget(target, authInfo);

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

  function providersExceptTarget(provider, source = scan) {
    const targetProvider = String(provider || '').trim();
    return targetProvider
      ? (source?.providers || []).filter((item) => item !== targetProvider)
      : [];
  }

  function fillTarget(provider, sourceLabel) {
    const targetProvider = String(provider || '').trim();
    if (!targetProvider) return false;
    setTarget(targetProvider);
    setOldProviders(providersExceptTarget(targetProvider));
    resetPlan();
    log(`Target Provider loaded from ${sourceLabel}: ${targetProvider}`);
    return true;
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
    const configTarget = data.configModelProvider || '';
    setTarget(configTarget);
    setOldProviders(configTarget ? (data.providers || []).filter((provider) => provider !== configTarget) : []);
    setIncludeSubagents(null);
    resetPlan();
    setStatus({ tone: configTarget ? 'good' : 'warn', text: configTarget ? '扫描完成，已读取 config provider' : '扫描完成，请手动填写 Target Provider' });
    log(`Found providers: ${data.providers.join(', ') || '(none)'}`);
    log(`Auth status: ${authStatusMeta(data.auth).label}`);
    if (configTarget) {
      log(`Target Provider loaded from config.toml: ${configTarget}`);
      log(`Auto-selected old providers: ${(data.providers || []).filter((provider) => provider !== configTarget).join(', ') || '(none)'}`);
    } else {
      log('[WARN] config.toml 未设置顶层 model_provider，请手动填写 Target Provider');
    }
    if (configTarget && data.latestUser?.model_provider && configTarget !== data.latestUser.model_provider) {
      log(`[WARN] config.toml 检测到 ${configTarget}，但最新聊天写入的是 ${data.latestUser.model_provider}。如果你最近切换过 provider，请确认要恢复到哪一个。`);
    }
    const authWarning = authWarningForTarget(configTarget, data.auth);
    if (authWarning) {
      setStatus({ tone: 'warn', text: '请确认 openai 认证状态' });
      log(`[WARN] ${authWarning}`);
    }
    refreshBackups(data.root || root, false);
  }

  function useConfigProvider() {
    if (!scan) {
      warn('请先点击深度扫描，再从 config 填入');
      return;
    }
    if (!configProvider) {
      warn('未在 config.toml 中找到顶层 model_provider，请手动填写 Target Provider');
      return;
    }
    fillTarget(configProvider, 'config.toml');
    if (latestProvider && latestProvider !== configProvider) {
      warn(`config.toml 检测到 ${configProvider}，但最新聊天写入的是 ${latestProvider}，请确认要恢复到哪一个`);
    }
  }

  function useLatestProvider() {
    if (!scan) {
      warn('请先点击深度扫描，再从最新聊天填入');
      return;
    }
    if (!latestProvider) {
      warn('扫描结果里没有可用的最新用户主聊天');
      return;
    }
    fillTarget(latestProvider, 'latest user thread');
    if (configProvider && latestProvider !== configProvider) {
      warn(`最新聊天写入的是 ${latestProvider}，但 config.toml 检测到 ${configProvider}，请确认要恢复到哪一个`);
    }
  }

  function handleTargetChange(value) {
    const nextTarget = value.trim();
    setTarget(value);
    setOldProviders((items) => items.filter((provider) => provider !== nextTarget));
    resetPlan();
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
    const authWarning = authWarningForTarget(targetProvider, scan?.auth);
    if (authWarning) log(`[WARN] ${authWarning}`);
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
    const authWarning = authWarningForTarget(targetProvider, scan?.auth);
    const authNotice = authWarning ? `\n\n认证提醒：${authWarning}` : '';
    const yes = window.confirm(`确认开始恢复？\n\n执行前会自动备份 Codex 状态。\nTarget Provider: ${targetProvider}\n需处理线程: ${plan.threadsToMigrate}\n需更新 JSONL: ${plan.jsonlToChange}${configSync}${authNotice}`);
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
    const yes = window.confirm(`确认回滚恢复设置？\n\n${label}\n\n工具会先备份当前状态，然后从所选备份读取 provider、thread_source、归档状态和 config provider，并写回当前 Codex 状态。\n\n不会覆盖聊天正文，不会把 rollout JSONL 整个恢复到旧版本，也不会删除备份之后新增的聊天内容。\n\nauth.json 请使用单独的“恢复 auth.json”按钮。建议先关闭或重启 Codex 桌面端，避免文件被占用。`);
    if (!yes) return;
    setStatus({ tone: 'info', text: '正在回滚恢复设置...' });
    const data = await call('restore-backup', () => api.restoreBackup({ root, backupPath: selectedBackup }));
    if (!data) return;
    setScan(null);
    resetPlan();
    setStatus({ tone: data.passed ? 'good' : 'warn', text: data.passed ? '恢复设置已回滚' : '恢复设置已回滚，有警告' });
    log(`Restore settings rolled back from backup: ${data.backup}`);
    log(`Safety backup created: ${data.safetyBackup}`);
    log(`Settings rollback complete: threads=${data.threads?.changed || 0}/${data.threads?.matched || 0}, JSONL first lines=${data.jsonlChanged || 0}/${data.jsonlMatched || 0}, skipped=${data.jsonlSkipped?.length || 0}`);
    if (data.config?.changed) log(`Config provider restored: ${data.config.previous || '(empty)'} -> ${data.config.current || '(empty)'}`);
    refreshBackups(root, false);
  }

  async function handleRestoreAuthBackup() {
    if (!selectedBackup) {
      warn('请先选择一个备份');
      return;
    }
    if (!selectedBackupInfo?.hasAuthJson) {
      warn('所选备份不包含 auth.json，无法恢复认证文件');
      return;
    }
    const label = selectedBackupInfo?.name || selectedBackup;
    const authLabel = authStatusMeta(selectedBackupInfo?.auth).label;
    const yes = window.confirm(`确认从这个备份恢复 auth.json？\n\n${label}\n备份认证状态：${authLabel}\n\n这只恢复认证文件，不迁移聊天记录。工具会先备份当前状态，然后把所选备份里的 auth.json 写回 Codex root。它不会生成或伪造 GPT/ChatGPT 账号登录态。`);
    if (!yes) return;
    setStatus({ tone: 'info', text: '正在恢复 auth.json...' });
    const data = await call('restore-auth-backup', () => api.restoreAuthBackup({ root, backupPath: selectedBackup }));
    if (!data) return;
    setScan(null);
    resetPlan();
    setStatus({ tone: data.skipped?.length ? 'warn' : 'good', text: data.skipped?.length ? 'auth.json 已恢复，有文件跳过' : 'auth.json 已恢复' });
    log(`Auth restored from backup: ${data.backup}`);
    log(`Safety backup created: ${data.safetyBackup}`);
    log(`Auth change: ${authStatusMeta(data.previousAuth).label} -> ${authStatusMeta(data.restoredAuth).label}`);
    refreshBackups(root, false);
  }

  async function handleDeleteBackup() {
    if (!selectedBackup) {
      warn('请先选择一个备份');
      return;
    }
    const label = selectedBackupInfo?.name || selectedBackup;
    const yes = window.confirm(`确认删除这个备份？\n\n${label}\n\n删除后，这个备份将无法再用于回滚。此操作只会删除选中的备份文件夹，不会删除 .codex 主目录或聊天记录。`);
    if (!yes) return;
    setStatus({ tone: 'info', text: '正在删除备份...' });
    const data = await call('delete-backup', () => api.deleteBackup({ root, backupPath: selectedBackup }));
    if (!data) return;
    setSelectedBackup('');
    setStatus({ tone: 'good', text: '备份已删除' });
    log(`Backup deleted: ${data.deleted}`);
    refreshBackups(root, false);
  }

  async function handleCleanupBackups() {
    const keep = Number(backupKeepCount);
    if (!Number.isInteger(keep) || keep < 1) {
      warn('保留数量必须是大于 0 的整数');
      return;
    }
    const preview = await call('cleanup-backups', () => api.cleanupBackups({ root, keep, yes: false }));
    if (!preview) return;
    if (!preview.expiredCount) {
      setStatus({ tone: 'good', text: '没有过期备份需要删除' });
      log(`No expired backups. Total=${preview.total}, keep=${preview.keep}`);
      return;
    }
    const names = (preview.expired || []).slice(0, 6).map((item) => item.name).join('\n');
    const more = preview.expiredCount > 6 ? `\n...以及另外 ${preview.expiredCount - 6} 个` : '';
    const yes = window.confirm(`确认删除过期备份？\n\n将保留最新 ${keep} 个本工具备份，删除更旧的 ${preview.expiredCount} 个。\n\n${names}${more}\n\n此操作不会删除 .codex 主目录或聊天记录。`);
    if (!yes) return;
    setStatus({ tone: 'info', text: '正在删除过期备份...' });
    const data = await call('cleanup-backups', () => api.cleanupBackups({ root, keep, yes: true }));
    if (!data) return;
    setSelectedBackup('');
    setStatus({ tone: 'good', text: '过期备份已删除' });
    log(`Expired backups deleted: ${data.deleted.length}, kept=${data.keep}`);
    refreshBackups(root, false);
  }

  const progressSteps = [
    { label: '目录', value: root ? '已填写' : '待填写', done: Boolean(root) },
    { label: '扫描', value: scan ? '已完成' : '待扫描', done: Boolean(scan) },
    { label: '方案', value: plan ? '已生成' : '待检查', done: Boolean(plan) },
    { label: '恢复', value: applyResult ? (applyResult.passed ? '完成' : '有警告') : '待执行', done: Boolean(applyResult), warn: applyResult && !applyResult.passed },
  ];

  return (
    <div className="relative z-10 flex min-h-screen flex-col selection:bg-orange-100">
      <header className="sticky top-0 z-50 border-b border-slate-200/70 bg-white/[0.82] backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-3 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-orange-100 bg-orange-50 text-orange-700 shadow-sm">
              <ArchiveRestore className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold text-slate-950">Codex History Recovery</h1>
              <p className="truncate text-[12px] font-medium text-slate-500">本地聊天记录恢复控制台</p>
            </div>
          </div>
          <StatusPill tone={status.tone} busy={busy}>{status.text}</StatusPill>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:py-8">
        <section className="mb-6 overflow-hidden rounded-lg border border-white/80 bg-white/[0.88] p-5 shadow-soft ring-1 ring-slate-950/[0.03] backdrop-blur-xl sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <div className="mb-2 inline-flex rounded-full border border-orange-100 bg-orange-50 px-3 py-1 text-[12px] font-semibold text-orange-700">
                Local Recovery Workbench
              </div>
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">恢复消失的 Codex 侧边栏聊天记录</h2>
              <p className="mt-2 max-w-2xl text-[14px] leading-6 text-slate-600">
                本机状态读取、Provider 迁移、备份回滚集中在同一套流程里，开始恢复前会先生成可检查方案。
              </p>
            </div>
            <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4 xl:w-[520px]">
              {progressSteps.map((step, index) => (
                <div key={step.label} className={cx('rounded-lg border px-3 py-3', step.warn ? 'border-amber-200 bg-amber-50 text-amber-800' : step.done ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500')}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-semibold">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <span className={cx('h-1.5 w-1.5 rounded-full', step.warn ? 'bg-amber-500' : step.done ? 'bg-emerald-500' : 'bg-slate-300')} />
                  </div>
                  <div className="text-[13px] font-semibold text-slate-900">{step.label}</div>
                  <div className="mt-0.5 text-[12px] font-medium opacity-80">{step.value}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
          <div className="flex flex-col gap-6 lg:sticky lg:top-[92px] lg:col-span-5">
            <Panel>
              <SectionHeader
                icon={FolderSearch}
                title="环境映射"
                eyebrow="Step 01"
                action={<Button tone="soft" onClick={() => detectDefaults(true)} busy={busy === 'defaults'} className="min-h-9 px-3 text-[12px]">重新检测目录</Button>}
              />
              <div className="space-y-5">
                <Field label="Root Directory" hint={rootHint}>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input value={root} onChange={(e) => updateRoot(e.target.value)} />
                    <Button onClick={browseRoot} className="shrink-0 px-4">更改</Button>
                  </div>
                </Field>
                <div className={cx('rounded-lg border px-4 py-3 text-[12px] font-semibold', stateDbReady ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-800')}>
                  <div className="flex items-center justify-between gap-3">
                    <span>状态数据库</span>
                    <span className={cx('rounded-full border bg-white/75 px-2.5 py-0.5 text-[11px]', stateDbReady ? 'border-emerald-200 text-emerald-700' : 'border-amber-200 text-amber-800')}>{stateDbStatus}</span>
                  </div>
                </div>
                <div className={cx('rounded-lg border px-4 py-3 text-[12px]', authToneClass(authMeta.tone))}>
                  <div className="flex items-center justify-between gap-3 font-semibold">
                    <span>认证状态</span>
                    <span className="shrink-0 rounded-full border border-current/20 bg-white/75 px-2.5 py-0.5 text-[11px]">{authMeta.label}</span>
                  </div>
                  <p className="mt-2 break-all text-[12px] font-medium leading-5 opacity-80">
                    {scan ? authMeta.description : `扫描后读取 ${authPath}`}
                  </p>
                </div>
                <div className="flex gap-3 pt-2">
                  <Button onClick={handleScan} tone="primary" busy={busy === 'scan'} className="flex-1">深度扫描</Button>
                </div>
              </div>
            </Panel>

            <Panel>
              <SectionHeader icon={ListChecks} title="迁移策略" eyebrow="Step 02" action={<Sparkles className="mt-2 h-4 w-4 text-orange-500" />} />
              <div className="space-y-6">
                <Field label="Target Injection (目标 Provider)">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input list="provider-options" value={target} onChange={(e) => handleTargetChange(e.target.value)} className={cx(inputClass, 'min-w-0 flex-1')} />
                    <datalist id="provider-options">{providerOptions.map((p) => <option value={p} key={p} />)}</datalist>
                    <Button tone="soft" onClick={useConfigProvider} disabled={!scan} className="shrink-0 px-3">从 config 填入</Button>
                    <Button tone="soft" onClick={useLatestProvider} disabled={!scan} className="shrink-0 px-3">从最新聊天填入</Button>
                  </div>
                  <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[12px] leading-5 text-slate-700">
                    <span className="font-semibold text-blue-700">提示：</span>
                    当前默认读取 <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-blue-700">{configTomlPath}</code> 顶层 <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-blue-700">model_provider</code> 作为 Target Provider。使用 GPT/ChatGPT 账号并直接使用账号额度时通常是 <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-blue-700">openai</code>；如果使用 Cockpit Tools、本地代理、API 中转或自定义 provider，则可能是 <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-blue-700">codex_local_access</code>、<code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-blue-700">cpa</code>、<code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-blue-700">right_code</code> 等名称。开始恢复时，工具会把 config.toml 同步为你确认的 Target Provider。
                    {scan && (
                      <span className="mt-2 block font-semibold text-slate-700">
                        {configProvider
                          ? `当前 config provider：${configProvider}${latestProvider && latestProvider !== configProvider ? `；最新聊天 provider：${latestProvider}，两者不一致时请手动确认。` : ''}`
                          : '未在 config.toml 中找到顶层 model_provider，请手动填写，或用最新聊天作为兜底参考。'}
                      </span>
                    )}
                  </div>
                  {openAiAuthWarning && (
                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-medium leading-5 text-amber-900">
                      <span className="font-semibold">认证提醒：</span>
                      {openAiAuthWarning}
                    </div>
                  )}
                </Field>

                <Field label="Include Subagents (包含子代理)">
                  <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-1">
                    <button type="button" onClick={() => { setIncludeSubagents(true); resetPlan(); }} className={cx('min-h-10 rounded-md px-3 text-[12px] font-semibold outline-none transition duration-200 focus-visible:ring-4 focus-visible:ring-orange-100', includeSubagents === true ? 'bg-white text-orange-700 shadow-sm ring-1 ring-orange-200' : 'text-slate-500 hover:bg-white/70 hover:text-slate-800')}>TRUE (是)</button>
                    <button type="button" onClick={() => { setIncludeSubagents(false); resetPlan(); }} className={cx('min-h-10 rounded-md px-3 text-[12px] font-semibold outline-none transition duration-200 focus-visible:ring-4 focus-visible:ring-orange-100', includeSubagents === false ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-white/70 hover:text-slate-800')}>FALSE (否)</button>
                  </div>
                </Field>

                <Field label="Target Overrides (要替换的旧 Provider)" hint="不要选目标 Provider">
                  <div className="flex min-h-[96px] flex-wrap gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    {providerOptions.length ? providerOptions.map((p) => {
                      const sel = oldProviders.includes(p);
                      const isTargetProvider = target.trim() && p === target.trim();
                      const hasConflict = sel && isTargetProvider;
                      return <button type="button" key={p} onClick={() => toggleOldProvider(p)} title={hasConflict ? '已选为旧 Provider，但它现在是 Target Provider，点击取消' : isTargetProvider ? '这是 Target Provider，不能作为旧 Provider' : ''} className={cx('flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold shadow-sm outline-none transition duration-200 focus-visible:ring-4 focus-visible:ring-orange-100', hasConflict ? 'border-rose-200 bg-rose-50 text-rose-700' : isTargetProvider ? 'border-amber-200 bg-amber-50 text-amber-800' : sel ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:text-orange-700')}><span className={cx("h-1.5 w-1.5 rounded-full", hasConflict ? "bg-rose-400" : isTargetProvider ? "bg-amber-400" : sel ? "bg-emerald-400" : "bg-slate-300")} />{p}</button>
                    }) : <div className="m-auto text-[12px] font-medium text-slate-400">请先执行扫描</div>}
                  </div>
                </Field>

                <div className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
                  <Button disabled={!scan} busy={busy === 'plan'} onClick={handlePlan}>检查方案</Button>
                  <Button tone="primary" busy={busy === 'apply'} disabled={!plan} onClick={handleApply}>开始恢复</Button>
                </div>
              </div>
            </Panel>

            <Panel>
              <SectionHeader
                icon={RotateCcw}
                title="备份回滚"
                eyebrow="Safety"
                accent="emerald"
                action={<Button tone="soft" onClick={() => refreshBackups(root)} busy={busy === 'backups'} className="min-h-9 px-3 text-[12px]">刷新备份</Button>}
              />

              <div className="space-y-4">
                <Field label="Backup Snapshot" hint={backups.length ? `${backups.length} 个备份` : '暂无备份'}>
                  <select
                    value={selectedBackup}
                    onChange={(e) => setSelectedBackup(e.target.value)}
                    className={inputClass}
                  >
                    {backups.length ? backups.map((item) => (
                      <option key={item.path} value={item.path}>
                        {item.name}
                      </option>
                    )) : <option value="">暂无本工具备份</option>}
                  </select>
                </Field>

                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] text-slate-600">
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
                      <div className="flex justify-between gap-3">
                        <span className="font-semibold text-slate-700">认证文件</span>
                        <span className={cx('max-w-[220px] truncate rounded-full border px-2 py-0.5 text-[11px] font-semibold', selectedBackupInfo.hasAuthJson ? authToneClass(selectedBackupAuthMeta.tone) : 'border-slate-200 bg-white text-slate-500')}>
                          {selectedBackupInfo.hasAuthJson ? selectedBackupAuthMeta.label : '不包含 auth.json'}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <span className="font-medium text-slate-400">选择备份后显示详情</span>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Button tone="danger" disabled={!selectedBackup} busy={busy === 'delete-backup'} onClick={handleDeleteBackup}>
                    删除当前备份
                  </Button>
                  <Button tone="soft" disabled={!selectedBackup || !selectedBackupInfo?.hasAuthJson} busy={busy === 'restore-auth-backup'} onClick={handleRestoreAuthBackup}>
                    恢复 auth.json
                  </Button>
                  <Button tone="accent" disabled={!selectedBackup} busy={busy === 'restore-backup'} onClick={handleRestoreBackup}>
                    回滚恢复设置
                  </Button>
                </div>

                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[12px] leading-5 text-blue-900">
                  <span className="font-semibold">说明：</span>
                  `回滚恢复设置` 只从备份读取 provider、索引相关状态和 config provider，不覆盖聊天正文；`恢复 auth.json` 只恢复认证文件。
                </div>

                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-[13px] font-semibold text-amber-950">过期备份清理</div>
                      <p className="mt-1 text-[12px] leading-5 text-amber-800/80">保留最新的本工具备份，删除更旧的备份。</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[12px] font-semibold text-amber-900">保留</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={backupKeepCount}
                        onChange={(e) => setBackupKeepCount(e.target.value)}
                        className="h-9 w-16 rounded-lg border border-amber-200 bg-white px-2 text-center text-[13px] font-semibold text-slate-900 outline-none transition focus:border-amber-400 focus:ring-4 focus:ring-amber-100"
                      />
                      <span className="text-[12px] font-semibold text-amber-900">个</span>
                    </div>
                  </div>
                  <Button tone="danger" disabled={!backups.length} busy={busy === 'cleanup-backups'} onClick={handleCleanupBackups} className="w-full">
                    删除过期备份
                  </Button>
                </div>
              </div>
            </Panel>
          </div>

          <div className="flex flex-col gap-6 lg:col-span-7">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Total" value={scan?.providers?.length ?? 0} />
              <Stat label="Threads" value={plan?.threadsToMigrate ?? '-'} tone="blue" />
              <Stat label="JSONL" value={plan?.jsonlToChange ?? '-'} tone="amber" />
              <Stat label="Status" value={applyResult ? (applyResult.passed ? 'OK' : 'WARN') : '-'} tone={applyResult?.passed ? 'green' : applyResult ? 'red' : 'slate'} />
            </div>

            <Panel className="min-w-0">
              <SectionHeader icon={Database} title="Provider 概览" eyebrow="Scan Result" accent="blue" />
              <ProviderTable rows={scan?.providerRows} />
            </Panel>

            <Panel className="min-w-0">
              <SectionHeader icon={Gauge} title="恢复方案" eyebrow="Dry Run" accent="orange" />
              <PlanCard plan={plan} />
            </Panel>

            <Panel className="overflow-hidden p-0">
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-5 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700">
                    <TerminalSquare className="h-4 w-4" />
                  </div>
                  <div>
                    <h2 className="text-[15px] font-semibold text-slate-950">系统日志</h2>
                    <p className="text-[12px] font-medium text-slate-500">Local operation stream</p>
                  </div>
                </div>
                <div className="hidden text-[11px] font-semibold uppercase text-slate-400 sm:block">system.log</div>
              </div>
              <div className="min-h-[320px] overflow-y-auto bg-slate-950 p-4 font-mono text-[12px] leading-relaxed">
                {logs.map((item, i) => (
                  <div key={i} className="flex gap-3 rounded px-2 py-0.5 break-all hover:bg-white/[0.04]">
                    <span className="shrink-0 text-slate-500">[{item.time}]</span> 
                    <span className={cx(item.text.includes('ERROR') ? 'text-rose-400' : item.text.includes('WARN') ? 'text-amber-400' : item.text.includes('OK') || item.text.includes('COMPLETE') ? 'text-emerald-400 font-medium' : 'text-slate-300')}>{item.text}</span>
                  </div>
                ))}
                <div className="mt-1 flex gap-3 px-2 py-0.5"><span className="text-slate-500">[{now()}]</span><span className="mt-1 h-3.5 w-2 animate-pulse bg-slate-400"></span></div>
              </div>
            </Panel>
          </div>
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
