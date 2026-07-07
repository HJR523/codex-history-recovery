# Codex History Recovery

一个用于恢复 Codex 桌面端侧边栏聊天记录的本地工具。

## 界面截图

![Codex History Recovery 主界面](docs/images/codex-recovery-console-v4.png)

## 使用场景

如果你在同一台电脑上切换过 Codex 的登录方式，例如从一种账号/授权方式切到另一种，可能会发现：以前的聊天内容其实还在本机，但 Codex 桌面端左侧边栏突然看不到了。

这个工具就是用来处理这种情况的。它会在本机检查 Codex 的历史记录和状态数据库，把仍然存在但没有显示出来的用户主聊天重新整理到当前 Codex 能识别的状态里。

当你切换登录方式、切换 provider、升级客户端或状态索引异常后，可能会遇到这种情况：

- 旧聊天内容仍在 `%USERPROFILE%\.codex\sessions`
- 旧聊天也可能仍在 `%USERPROFILE%\.codex\archived_sessions`
- `state_5.sqlite` 里仍有线程记录
- 但 Codex 桌面端侧边栏不显示旧聊天

这个工具会扫描 `.codex` 状态，生成恢复计划，自动备份关键文件，然后同步 SQLite、JSONL、`session_index.jsonl` 和 workspace hints。

## 重要提醒

这个工具会修改本机 Codex 状态文件。执行恢复前会自动备份，但仍建议先关闭或重启 Codex 桌面端，减少活动会话文件被占用。

默认只迁移用户主聊天，不迁移 subagents。

## 功能

- React + Tailwind CSS 现代界面
- 本地 Node.js 服务处理文件和状态数据库
- 内置数据库访问能力，无需额外安装数据库工具
- 扫描 provider 分布
- 默认读取 `config.toml` 顶层 `model_provider` 作为 Target Provider
- 保留最新用户聊天 provider 作为验证或兜底参考
- 手动选择 target provider
- 手动选择旧 provider
- 可选择是否包含 subagents
- 恢复前检查方案
- 执行前自动备份
- 执行后自动验证
- 可打包为 Windows 安装包和便携版桌面应用
- 保留 Windows 双击启动脚本

## 环境要求

### 下载桌面版

- Windows 10/11
- 不需要安装 Node.js
- 不需要安装 npm
- 不需要安装 sqlite3

如果你下载的是 GitHub Releases 里的安装包或便携版，直接运行即可。

### 从源码运行

- Windows
- Node.js 22.5 或更高版本
- npm

本工具使用 Node.js / Electron 内置 SQLite 能力，不需要额外安装 sqlite3 或数据库工具。从源码运行时，用户只需要准备 Node.js 和 npm。

## 快速使用

### 方法一：下载桌面版（推荐）

在 GitHub Releases 下载其中一个文件：

```text
Codex-History-Recovery-Setup-版本号-x64.exe
Codex-History-Recovery-Portable-版本号-x64.exe
```

`Setup` 是安装版，双击后按提示安装，之后可以从桌面图标或开始菜单打开。

`Portable` 是便携版，不需要安装，双击即可打开。

桌面版打开后会直接显示恢复界面，不需要手动安装 Node.js，不需要打开命令行，也不需要访问本地网址。

### 方法二：双击源码启动

双击：

```text
restore-codex-sidebar-chat.cmd
```

首次启动会自动执行：

```text
npm install
npm run build
node --no-warnings server.cjs
```

随后浏览器会自动打开本地界面。

使用期间不要关闭弹出的命令行窗口，因为它就是本地恢复服务。

### 方法三：命令行启动

```powershell
cd D:\Codex\history-recovery
npm install
npm run app
```

如果只想启动已经构建好的版本：

```powershell
npm run build
npm start
```

默认本地服务地址：

```text
http://127.0.0.1:47321
```

如果端口被占用，工具会自动尝试下一个端口。

## 使用流程

1. 关闭或重启 Codex 桌面端。
2. 启动本工具。
3. 确认自动填入的 `Codex root`，如不正确可点击 `更改` 或 `重新检测目录`。
4. 确认界面显示 `状态数据库: 已就绪`。
5. 点击 `深度扫描`。
6. 工具会读取 `%USERPROFILE%\.codex\config.toml` 顶层 `model_provider`，并自动填入 `Target Provider`。
7. 查看 provider 分布，确认 `Target Provider` 是否正确。
8. 如果不确定，可以点击 `从最新聊天填入`，用最近一次实际写入的用户聊天 provider 进行对比或兜底。
9. 选择是否迁移 subagents。
10. 确认需要替换的旧 provider，工具会默认勾选 Target Provider 以外的 provider。
11. 点击 `检查方案`。
12. 确认方案无误后点击 `开始恢复`。
13. 看到验证通过后，重启 Codex 桌面端。

## 核心概念

### Codex root

Codex 的本地状态目录。默认是：

```text
%USERPROFILE%\.codex
```

常见关键文件包括：

```text
%USERPROFILE%\.codex\state_5.sqlite
%USERPROFILE%\.codex\session_index.jsonl
%USERPROFILE%\.codex\.codex-global-state.json
%USERPROFILE%\.codex\sessions
%USERPROFILE%\.codex\archived_sessions
```

### Provider

Provider 是 Codex 线程记录里的 `model_provider` 字段。侧边栏恢复时，SQLite 和 JSONL 第一行里的 provider 需要对齐。

常见情况：

- 当前新聊天显示正常，但旧聊天不显示
- 新聊天使用 provider A
- 旧聊天还记录着 provider B
- 侧边栏只显示当前 provider 下的用户线程

此时需要把旧聊天的 provider 从 B 同步到 A。

### Target Provider

Target Provider 是你希望旧聊天迁移到的目标 provider。

本工具面向普通 Codex 桌面端用户，默认读取当前用户：

```text
%USERPROFILE%\.codex\config.toml
```

里的顶层：

```toml
model_provider = "..."
```

作为 Target Provider。

例如：

```toml
model_provider = "codex_local_access"
```

那么本工具会默认把 Target Provider 判断为：

```text
codex_local_access
```

如果你使用 GPT/ChatGPT 账号登录，并且直接使用账号额度，常见 provider 是 `openai`。

如果你使用 Cockpit Tools、本地代理、API 中转、自定义 provider 或其他接入方式，provider 可能不是 `openai`，而是 `config.toml` 中 `model_provider` 指向的名称，例如 `codex_local_access`、`cpa`、`right_code` 等。

这里的 provider 是写入 Codex 历史线程元数据的 provider 名称，不是 model 名称，也不是 `base_url`。

`从最新聊天填入` 会保留，但它只是验证或兜底功能。它读取的是 `state_5.sqlite` 里最近一次实际写入的用户主聊天 provider，不再作为默认 Target Provider 来源。

如果 `config.toml` 没有顶层 `model_provider`，工具不会仅凭 ChatGPT 登录状态自动猜 `openai`，而是提示你手动填写。你也可以新建一个能正常显示的 Codex 聊天，发送一句很短的消息，再点击 `从最新聊天填入` 作为参考。

如果你通过 CLI 参数、profile、自定义 `CODEX_HOME` 或特殊启动器覆盖了 Codex 配置，请以实际启动环境为准，并手动确认 Target Provider。

开始恢复时，工具会把 `config.toml` 同步为你最终确认的 Target Provider。

### Target Provider Injection 是什么

这里的 Target Provider Injection 指的是：把你确认过的 Target Provider 写入需要恢复的旧用户线程，使 SQLite 和 JSONL 元数据保持一致。

工具会同步两类位置：

```text
state_5.sqlite 的 threads.model_provider
rollout-*.jsonl 第一行 session_meta.payload.model_provider
```

这不是注入代码，也不会改聊天正文。它只是把旧线程的 provider 元数据改成当前 Codex 能识别和显示的 provider。

### 旧 Provider

旧 Provider 是当前不再显示或不再匹配的 provider。

示例：

```text
Target Provider: codex_local_access
Old Provider: cpa
```

这表示工具会把旧的 `cpa` 用户线程迁移到 `codex_local_access`。

旧 Provider 不能包含 Target Provider。也就是说，`Target Overrides` 里应该勾选“旧聊天当前还带着的 provider”，不要勾选你准备写入的目标 provider。

如果这里选错，常见表现是：

- 工具提示 Target Overrides 不能包含 Target Provider
- 检查方案时显示 0 个待恢复线程、0 个待更新 JSONL
- 恢复后旧聊天仍然没有出现在侧边栏

遇到这种情况，先确认 `config.toml` 顶层 `model_provider` 是否是当前实际使用的 Target Provider；如果你最近切换过 provider，可以用 `从最新聊天填入` 对比最近聊天实际写入的 provider，再从 provider 分布里确认旧聊天原本使用的 provider。

### Subagents 是什么

Subagents 是 Codex 在执行任务时可能创建的辅助线程。它们通常不是你在侧边栏直接打开的主聊天，而是内部协作、分析、审查或子任务线程。

在数据库里通常表现为：

```text
thread_source='subagent'
```

普通用户主聊天通常是：

```text
thread_source='user'
```

默认建议不要迁移 subagents，原因是：

- 侧边栏恢复主要依赖用户主聊天
- subagents 可能不是侧边栏应显示的主会话
- 大批量迁移 subagents 可能让索引变得杂乱

只有在你明确知道这些 subagent 线程也需要同步 provider 时，才选择迁移 subagents。

## 工具会修改什么

执行恢复时，工具可能修改：

```text
%USERPROFILE%\.codex\state_5.sqlite
%USERPROFILE%\.codex\sessions\...\rollout-*.jsonl
%USERPROFILE%\.codex\archived_sessions\...\rollout-*.jsonl
%USERPROFILE%\.codex\session_index.jsonl
%USERPROFILE%\.codex\.codex-global-state.json
%USERPROFILE%\.codex\config.toml
```

执行前会自动备份：

```text
%USERPROFILE%\.codex\backup-YYYYMMDD-HHMMSS-pre-chat-history-restore
```

备份中包含：

- SQLite 状态文件
- WAL/SHM 文件
- session index
- global state
- config
- sessions
- archived sessions
- manifest.json

## 备份回滚

如果恢复结果不符合预期，可以在界面左侧的 `备份回滚` 区域恢复到某个自动备份。这里的备份列表只显示本工具生成的备份；工具会读取备份目录里的 `manifest.json`，确认它是本项目创建的恢复备份后才允许恢复或删除。

1. 点击 `刷新备份`。
2. 在 `Backup Snapshot` 中选择要恢复的备份。
3. 点击 `恢复此备份`。
4. 根据提示确认操作。

执行回滚前，工具会再自动备份一次当前状态。也就是说，即使选错了备份，仍然会留下一个新的安全备份用于再次回滚。

建议在执行回滚前关闭或重启 Codex 桌面端，避免状态文件被占用。

如果确认某个备份不再需要，可以在同一区域选择该备份并点击 `删除当前备份`。该操作只会删除下拉框当前选中的本项目备份文件夹，不会删除 `.codex` 主目录或聊天记录。

## 备份清理

备份文件夹只用于在需要时回滚到恢复前状态，Codex 正常运行不依赖这些备份。确认侧边栏聊天记录已经恢复正常、且不再需要回滚后，可以在界面里删除旧备份，也可以手动清理旧备份。

界面里的 `删除过期备份` 用于批量清理旧备份。你可以设置“保留”数量，例如保留最新 2 个；工具会先预览将要删除的过期备份数量并要求确认，然后只删除更旧的本项目备份。

建议至少保留最新 1-2 个备份。手动清理时，可以在资源管理器中打开：

```text
%USERPROFILE%\.codex
```

只删除名称类似下面格式的文件夹：

```text
backup-YYYYMMDD-HHMMSS-pre-chat-history-restore
```

不要删除整个 `.codex` 文件夹。

也可以用 PowerShell 先查看已有备份：

```powershell
Get-ChildItem "$env:USERPROFILE\.codex" -Directory -Filter "backup-*-pre-chat-history-restore" |
  Sort-Object LastWriteTime -Descending |
  Select-Object Name, LastWriteTime, FullName
```

保留最新 2 个备份，清理更旧的备份：

```powershell
Get-ChildItem "$env:USERPROFILE\.codex" -Directory -Filter "backup-*-pre-chat-history-restore" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 2 |
  Remove-Item -Recurse
```

如果想先预览将要删除哪些备份，可以把最后一行临时改成 `Remove-Item -Recurse -WhatIf`。

## 验证标准

恢复完成后，工具会输出验证指标。

理想结果：

```text
INDEX_BAD=0
null_thread_source=0
USER_THREADS_MISSING_HINT=0
JSONL_USER_MISMATCH=0
JSONL_BAD=0
```

如果 `JSONL_LOCKED` 大于 0，通常是 Codex 正在占用活动线程。关闭或重启 Codex 后再运行一次。

## 故障排查

### 双击没有反应

打开命令行手动运行：

```powershell
cd D:\Codex\history-recovery
restore-codex-sidebar-chat.cmd
```

如果提示找不到 Node.js，请安装 Node.js 22.5 或更高版本，并把 Node.js 加入 PATH。

### npm install 失败

如果安装依赖时报错，优先检查：

- Node.js 是否为 22.5 或更高版本
- 网络是否能访问 npm
- 是否在公司代理或安全软件拦截环境中

### 浏览器没有自动打开

查看命令行窗口里的地址，例如：

```text
Codex History Recovery is running at http://127.0.0.1:47321
```

手动复制到浏览器打开。

### 旧聊天仍未显示

检查：

- 是否重启了 Codex 桌面端
- Target Provider 是否选对
- 旧 Provider 是否勾选正确
- 是否只恢复了空 provider
- 验证指标是否有非 0 项
- 是否有 JSONL_LOCKED

### 不确定 Target Provider 怎么选

优先看 `%USERPROFILE%\.codex\config.toml` 顶层 `model_provider`。工具点击 `深度扫描` 后会自动读取并填入。

如果没有检测到顶层 `model_provider`，或者你怀疑最近切换过 provider，可以新建一个 Codex 新聊天，发送一句短消息，确认它能在侧边栏显示，再回到工具点击 `从最新聊天填入` 作为对照。

## 开发

安装依赖：

```powershell
npm install
```

开发模式：

```powershell
npm run dev
```

构建前端：

```powershell
npm run build
```

启动本地服务：

```powershell
npm start
```

构建并启动：

```powershell
npm run app
```

启动桌面预览：

```powershell
npm run desktop
```

生成 Windows 安装包和便携版：

```powershell
npm run dist:win
```

打包产物会生成到 `release` 目录。该目录只用于本机发布构建，不需要提交到仓库。

也可以直接推送版本标签，让 GitHub Actions 在 Windows 环境中自动打包并发布到 GitHub Releases：

```powershell
git tag v2.0.0
git push origin v2.0.0
```

## 项目结构

```text
.
├── .github/
│   └── workflows/
├── build/
│   ├── icon.ico
│   └── icon.png
├── electron/
│   ├── main.cjs
│   └── preload.cjs
├── src/
│   ├── main.jsx
│   └── styles.css
├── docs/
│   └── images/
├── index.html
├── server.cjs
├── package.json
├── package-lock.json
├── tailwind.config.js
├── postcss.config.js
├── vite.config.js
├── restore-codex-sidebar-chat.cmd
├── README.md
└── README-EN.md
```

## License

MIT
