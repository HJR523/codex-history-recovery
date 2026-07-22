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

它也会检测并备份 `auth.json`。需要注意的是：provider 负责聊天记录归属和侧边栏显示，`auth.json` 负责 Codex 当前的认证状态。把聊天记录 provider 改成 `openai` 并不等于恢复 GPT/ChatGPT 账号登录态。

## 重要提醒

这个工具会修改本机 Codex 状态文件。执行恢复前会自动备份，但仍建议先关闭或重启 Codex 桌面端，减少活动会话文件被占用。

工具可以从已有备份恢复 `auth.json`，但不能生成、伪造或转换 GPT/ChatGPT 账号登录凭据。如果账号登录已经失效，请先在 Codex 中重新登录。

默认只迁移用户主聊天，不迁移 subagents。

## 功能

- React + Tailwind CSS 现代界面
- 本地 Node.js 服务处理文件和状态数据库
- 内置数据库访问能力，无需额外安装数据库工具
- 扫描 provider 分布
- 默认读取 `config.toml` 顶层 `model_provider` 作为 Target Provider
- 保留最新用户聊天 provider 作为验证或兜底参考
- 检测当前 `auth.json` 认证状态
- 手动选择 target provider
- 手动选择旧 provider
- 可选择是否包含 subagents
- 恢复前检查方案
- 执行前自动备份
- 自动备份 `auth.json`
- 可勾选具体的用户主聊天，导出为 `.codex-history` 并在其他电脑或 Windows 用户下预检、选择性导入
- 可手动保存当前 `auth.json` 为专用认证快照
- 保存时自动清理内容重复的 `auth.json` 专用快照
- 可从备份回滚恢复设置，且不覆盖聊天正文
- 可查看并编辑备份中的 config provider 和完整 `auth.json`
- 可分别应用 config provider、`auth.json`，或同时应用两者
- Provider 按名称去重、`auth.json` 按内容指纹去重并支持自定义版本名称
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

下载地址：[下载最新版](https://github.com/HJR523/codex-history-recovery/releases/latest)

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
7. 查看 `认证状态`。如果你使用 GPT/ChatGPT 账号登录，Target Provider 通常是 `openai`，但认证状态不应该是 `API Key 模式`。
8. 查看 provider 分布，确认 `Target Provider` 是否正确。
9. 如果不确定，可以点击 `从最新聊天填入`，用最近一次实际写入的用户聊天 provider 进行对比或兜底。
10. 选择是否迁移 subagents。
11. 确认需要替换的旧 provider，工具会默认勾选 Target Provider 以外的 provider。
12. 点击 `检查方案`。
13. 确认方案无误后点击 `开始恢复`。
14. 看到验证通过后，重启 Codex 桌面端。

## 核心概念

### 跨电脑 / 跨 Windows 用户迁移

此功能迁移本地已保存的用户主聊天（`thread_source='user'`），不包含 subagent。它不是账号或登录态迁移：迁移包不会包含 `auth.json`、`config.toml`、API Key、token 或其他凭据。

1. 在源电脑或源 Windows 用户下，打开 `聊天迁移包：导出`，读取聊天列表，勾选需要打包的聊天，再选择保存位置。
2. 将生成的 `.codex-history` 文件复制到目标电脑或目标 Windows 用户。
3. 在目标 Codex root 的 `聊天迁移包：导入` 中选择并检查该文件。界面会显示“可导入 / 已存在 / 冲突 / 不兼容”；只可导入状态为“可导入”的聊天。
4. 可选填写 Target Provider 覆盖值，以及一组“源 workspace 路径 → 目标 workspace 路径”映射。它们只影响这次导入的聊天，不会修改目标 `config.toml`。
5. 开始导入。工具会先创建 `pre-chat-history-import` 安全备份，导入线程记录和 JSONL 正文，并重建 `session_index.jsonl` 与 workspace hints。

同一聊天 ID 且内容相同会识别为“已存在”并跳过；同一 ID 但内容不同会标为“冲突”且绝不覆盖目标数据。源、目标的 `threads` 表结构必须完全一致，否则导入会拒绝执行。迁移前建议在两端都先关闭 Codex，避免活动会话文件被占用。

安全备份会使用 SQLite 一致性快照；任何关键文件无法复制时，导入或恢复会在写入前中止。数据库和相关设置文件使用协调事务，写入或验证失败时会自动恢复原状态。单个迁移包最大支持 128 MB 压缩体积、256 MB 解压体积，压缩和解压异步执行；超过限制时请分批导出聊天。

迁移包仍会保留所选聊天正文；如果聊天中粘贴过凭据或隐私信息，它们也会随包迁移，应按敏感文件保管。

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

### auth.json 与账号登录态

`auth.json` 是 Codex 当前认证状态相关的本地文件。它和 Target Provider 是两件事：

- Target Provider 决定旧聊天记录要迁移到哪个 provider 名称下
- `auth.json` 决定 Codex 当前是否处于某种可用的认证状态

如果你使用 GPT/ChatGPT 账号登录并直接使用账号额度，Target Provider 通常是 `openai`。但只有把聊天记录和 `config.toml` 改成 `openai`，并不一定能恢复账号登录态；如果当前 `auth.json` 仍是 API Key 模式，Codex 可能仍然无法按 GPT/ChatGPT 账号方式发消息。

本工具会在 `深度扫描` 后显示 `认证状态`：

- `API Key 模式`：当前更像 API Key 认证，不等于 GPT/ChatGPT 账号登录
- `账号登录态可能存在`：检测到账号登录相关信号，但仍以 Codex 实际能否发消息为准
- `未找到 auth.json`：当前 Codex root 下没有认证文件

执行恢复前，工具会把当前 `auth.json` 一起备份。如果你之前有一个能正常使用 GPT/ChatGPT 账号登录的备份，可以在 `备份版本内容` 的 `auth.json 版本` 中单独选择、查看并应用它。这个操作不迁移聊天记录。

如果当前 Codex 登录状态是正常的，建议点击 `保存当前 auth.json` 主动保存一次认证快照。这个快照只包含 `auth.json` 和可选的 `auth.json.bak`，不会复制聊天正文，也不会修改 provider、SQLite 或 `config.toml`。

保存成功后，工具会按 `auth.json` 文件内容计算指纹，自动删除由 `保存当前 auth.json` 生成、且内容完全相同的旧快照；完整恢复备份不会因为 `auth.json` 重复而被删除。

工具不能生成、伪造或转换 GPT/ChatGPT 账号登录凭据。如果没有可用备份，请先在 Codex 中重新登录账号，再回来恢复聊天记录。

`auth.json` 可能包含账号登录凭据或 token。不要把 `.codex` 里的 auth 快照、完整备份或 `auth.json` 分享给别人，也不要上传到公开仓库。

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
%USERPROFILE%\.codex\auth.json
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
- auth.json
- sessions
- archived sessions
- manifest.json

## 备份回滚

如果恢复结果不符合预期，可以在界面左侧的 `备份回滚` 区域选择一个自动备份，然后点击 `回滚恢复设置`。这里的备份列表只显示本工具生成的备份；工具会读取备份目录里的 `manifest.json`，确认它是本项目创建的恢复备份后才允许回滚或删除。

`回滚恢复设置` 不会把聊天记录退回备份时间。它只从备份读取恢复相关状态，并写回当前 Codex 状态：

- `state_5.sqlite` 中现有线程的 `model_provider`
- `state_5.sqlite` 中现有线程的 `thread_source`
- `state_5.sqlite` 中现有线程的归档状态
- 当前 `rollout-*.jsonl` 第一行 `session_meta.payload.model_provider`
- `config.toml` 顶层 `model_provider`
- 重新生成 `session_index.jsonl`
- 补齐 workspace hints

它不会覆盖：

- `rollout-*.jsonl` 第 2 行以后的聊天正文
- 备份之后新增的聊天内容
- 当前存在但备份里不存在的新线程
- `auth.json`

使用流程：

1. 点击 `刷新备份`。
2. 在 `Backup Snapshot` 中选择要参考的备份。
3. 点击 `回滚恢复设置`。
4. 根据提示确认操作。

执行回滚前，工具会再自动备份一次当前状态。也就是说，即使选错了备份，仍然会留下一个新的安全备份用于再次处理。

建议在执行回滚前关闭或重启 Codex 桌面端，避免状态文件被占用。

### 查看和编辑备份版本

页面下方将 `备份回滚` 与 `备份版本内容` 并排显示。版本内容不依赖回滚区当前选中的备份。

`备份版本内容` 中有两套互相独立的选择：

- `Provider 版本`：汇总所有备份 `config.toml` 顶层的 `model_provider`，按名称去重，例如 `openai`、`custom`
- `auth.json 版本`：汇总所有包含认证文件的备份，按 `auth.json` 内容指纹去重

Provider 选择后仍可编辑最终写入值。每个 auth 版本都有独立显示名称，可以在界面中修改并保存；相同内容指纹的重复备份会同步使用这个名称。名称只写入备份的 `manifest.json`，不会修改认证文件内容。保存当前 `auth.json` 快照时也可以直接输入版本名称。

Provider 与 auth.json 区域都提供“删除当前备份”按钮。按钮只删除当前所选版本对应的一个备份文件夹，不会批量删除同名 Provider 或同指纹认证版本，也不会修改当前 `.codex` 中的配置、认证文件或聊天记录。由于一个备份文件夹可能同时包含 Provider 和 auth.json，确认框会提示删除后可能同时影响另一侧的版本列表。

`config.toml` 和 `auth.json` 可以分别应用，也可以一起应用。点击 `应用已选内容` 后，工具会把编辑后的值写入当前 Codex root，并在写入前创建完整安全备份。原备份中的 provider 和 `auth.json` 内容不会被修改；`auth.json` 必须是有效的 JSON 对象。

完整 `auth.json` 可能包含账号凭据和 token。查看或编辑时不要截图、录屏或分享界面内容。

### 回滚为什么保留最新聊天

`回滚恢复设置` 是保留最新聊天内容的安全路径。它不会复制备份里的聊天正文，而是把备份中的 provider、线程来源和归档状态映射到当前仍存在的线程，再修改当前 JSONL 第一行并重建索引。因此备份之后新增或继续更新的聊天正文仍然保留。

这个工具不提供将聊天正文和会话目录整包覆盖回旧时间点的功能。

如果只想应用认证状态，可以在 `备份版本内容` 中选择一个 `auth.json 版本`，勾选 `完整 auth.json` 的“应用”，再点击 `应用已选内容`。这个操作不会改 SQLite、JSONL 或聊天记录。

如果只是想把当前可用的认证状态留一份副本，点击 `保存当前 auth.json`。它会生成名称类似下面的专用快照：

```text
backup-YYYYMMDD-HHMMSS-manual-auth-snapshot
```

这种快照会出现在 `auth.json 版本` 列表中，可单独查看、编辑和应用，但不能用于 `回滚恢复设置`。保存新快照后，内容相同的旧 auth 专用快照会被自动删除。

如果确认某个备份不再需要，可以在同一区域选择该备份并点击 `删除当前备份`。该操作只会删除下拉框当前选中的本项目备份文件夹，不会删除 `.codex` 主目录或聊天记录。

## 备份清理

备份文件夹只用于在需要时回滚到恢复前状态，Codex 正常运行不依赖这些备份。确认侧边栏聊天记录已经恢复正常、且不再需要回滚后，可以在界面里删除旧备份，也可以手动清理旧备份。

界面里的 `删除过期备份` 用于批量清理旧备份。你可以设置“保留”数量，例如保留最新 2 个；工具会先预览将要删除的过期备份数量并要求确认，然后只删除更旧的本项目备份。

重复 auth 快照无需手动清理。每次点击 `保存当前 auth.json` 后，工具都会自动检查专用认证快照，保留每一种不同 `auth.json` 内容的最新一份，删除内容完全相同的旧副本。完整恢复备份不参与这项清理。

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

### Target Provider 是 openai，但仍然发不了消息

先看界面的 `认证状态`。如果显示 `API Key 模式`、`未找到 auth.json` 或 `未知认证模式`，说明聊天记录可以迁移到 `openai`，但当前 Codex 不一定拥有 GPT/ChatGPT 账号登录态。

可选处理方式：

- 先在 Codex 中重新登录 GPT/ChatGPT 账号，再运行本工具恢复聊天记录
- 如果本工具备份里有曾经可用的账号登录态，在 `备份版本内容` 中选择对应的 `auth.json 版本` 并单独应用
- 如果你本来就使用 API Key 或自定义 provider，不要盲目把 Target Provider 改成 `openai`，应使用当前实际可发消息的 provider

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
git tag vX.Y.Z
git push origin vX.Y.Z
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
