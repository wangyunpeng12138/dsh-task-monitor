# DSH 任务监控悬浮窗

[English](README.md) | [简体中文](README.zh-CN.md)

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面任务监控器。它用完全透明的悬浮球和紧凑面板展示会话实时进度，让你不切换回 DSH 也能掌握长时间运行的 Agent 任务。

项目按 [docs/solution.zh-CN.md](docs/solution.zh-CN.md) 中的混合方案 B 实现：

```text
DSH Host 插件桥 ──本机回环 HTTP/SSE──┐
                                      ├──> Rust 单一状态源 ──> 悬浮球 + 面板
DSH 投影缓存    ──只读文件适配────────┘
```

## 功能

- **完全透明的 72×72 悬浮球**：只绘制进度环、数量/状态文字和等待提示点，桌面内容直接透出。
- **高对比度文字**：深色字形 + 浅色描边，在浅色和深色桌面上都更清晰。
- **任务面板**：按需介入、运行中、失败、最近完成分组；展示 Todo 进度、当前步骤、耗时、后台任务、Goal 与上下文压力。
- **悬浮球 ↔ 面板切换**：点击球打开面板，面板 `◎` 回到悬浮球，`✕` 隐藏到托盘；全局热键 `Ctrl+Alt+Shift+M` 和托盘可恢复。
- **双数据通道**
  - **插件桥（实时）**：DSH Host 插件折叠会话事件，通过带 token、仅回环的快照/SSE 接口发布。
  - **文件适配器（零安装）**：读取 DSH 投影缓存，未安装插件也能工作。
- **Windows 集成**：置顶、跳过任务栏、拖动、边缘吸附、单实例、托盘。
- **隐私优先**：不传输对话正文、工具完整输出或凭据；只传标题、Todo 文本、路径、命令 label 与计数。

## 环境要求

| 组件 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 x64 |
| WebView2 | Windows 11 自带；Windows 10 需安装 Evergreen Runtime |
| Node.js | 20+ |
| pnpm | 9+ |
| Rust | Stable，MSVC target |
| MSVC | Visual Studio Build Tools（C++ 工作负载） |
| DSH | Desktop 0.2.x（已在 `0.2.2-rc.1` 验证） |

## 快速开始

### 一键启动（Windows）

双击 [`start.bat`](start.bat)，或在终端运行：

```powershell
.\start.bat            # 启动 release 版本
.\start.bat -Rebuild   # 先重新构建，再启动
.\start.bat -Dev       # Vite + Tauri 开发模式
```

脚本会启动 `target/release/dsh-task-monitor.exe`。如果该文件尚不存在，会先自动构建（需要 Rust 与 pnpm）。如果监控已在运行，再次启动会直接打开面板，不会产生第二个实例。

### 手动启动

```powershell
pnpm install
pnpm --filter @dsh-monitor/desktop tauri dev
```

`cargo` 不在 `PATH` 时，先设置 Rust 环境，例如：

```powershell
$env:CARGO_HOME = "$env:USERPROFILE\.cargo"
$env:RUSTUP_HOME = "$env:USERPROFILE\.rustup"
$env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
```

仅调试前端：

```powershell
pnpm --filter @dsh-monitor/desktop dev
```

辅助脚本：

```powershell
.\scripts\run-desktop.ps1          # tauri dev
.\scripts\run-desktop.ps1 -Build   # tauri build
```

## 构建

```powershell
pnpm --filter @dsh-monitor/desktop tauri build
```

产物：

- `apps/desktop/src-tauri/target/release/dsh-task-monitor.exe`
- `apps/desktop/src-tauri/target/release/bundle/nsis/`（启用打包时的安装包）

当前 release 未签名，Windows SmartScreen 可能在首次运行时提示。

## 安装 DSH 插件（可选，开启实时模式）

插件位于 `apps/plugin`，使用本地 link 安装，不发布私服：

```powershell
# 安装到 desktop profile
dsh plugin --profile desktop add "link:$((Resolve-Path .)\apps\plugin)"
```

然后重启 DSH Desktop，在 **Settings → Plugins** 中启用 **DSH Task Monitor bridge**。CLI 只负责装包，bundle 选择由插件管理器完成。

开发期也可直接运行 `.\scripts\install-plugin.ps1`。

插件启动后写入发现文件：

```text
%USERPROFILE%\.dsh\storages\task-monitor\bridges\<pid>-<profile>.json
```

悬浮端读取该文件，使用每进程随机 token 认证，并每 500 ms 请求一次 `/v1/snapshot`。插件同时提供 `/v1/events`（SSE），Rust 端直连解析计划在 M2 接入。插件缺失或未启用时自动回退文件模式。

## 工作原理

### 数据源

| 模式 | 来源 | 延迟 | 说明 |
|---|---|---|---|
| 插件 | DSH Host 插件，本机回环 HTTP | 约 0.5 s | 完整事件、Job、子代理、控制动作 |
| 文件 | `storages/session_projcache/sessions/*.json` | ≤ 5 s / 200 事件 | 零安装、只读、近期任务 |
| 离线 | — | — | DSH 未运行或未找到 DSH Home |

### 桥接安全

- 只监听 `127.0.0.1`，端口由系统分配。
- 所有请求要求 `Authorization: Bearer <token>`；token 每进程随机生成，存放在发现文件中。
- 拒绝非回环 `Host` 与跨站 `Origin`。
- 不写 DSH 会话日志或投影缓存。

## 配置

面板右上角 ⚙ 打开设置。

| 配置 | 默认 | 说明 |
|---|---|---|
| DSH Home | 自动 | 优先 `DSH_HOME`，否则 `%USERPROFILE%\.dsh` |
| 数据源模式 | 自动 | `auto` / `plugin` / `file` |
| 挂起阈值 | 90 s | 运行中任务无更新后标记为疑似挂起 |
| 最大任务数 | 30 | 面板卡片上限 |
| 空闲时隐藏 | 关 | 没有运行/待介入任务时隐藏悬浮球 |
| 热键 | `Ctrl+Alt+Shift+M` | 显隐面板 |

设置保存于 `%APPDATA%\com.dshmonitor.desktop\settings.json`。

## 目录结构

```text
apps/desktop/              Tauri 2 + Vue 3 桌面端
  src/                     BallView / PanelView / TaskCard / SettingsDialog
  src-tauri/src/           Rust：core / model / settings / 文件与桥接数据源
apps/plugin/               DSH Host bundle：事件折叠 + 回环桥
packages/protocol/         两端共享的 TypeScript 协议类型
docs/                      设计与架构文档
scripts/                   启动器、图标生成、开发/构建、插件安装
start.bat                  Windows 一键启动脚本
```

## 开发与验证

```powershell
pnpm -r --if-present typecheck
pnpm -r --if-present test
cargo test --offline --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

当前验证状态：

- Vue/TypeScript 类型检查：通过
- 插件测试（reducer / store / bridge）：8/8 通过
- Rust 单元测试：2/2 通过
- Release 构建：通过
- 实时桥：使用独立 headless DSH Host 完成端到端验证
- 文件模式：使用真实 DSH 投影缓存验证

## 已知限制

- Rust 桥接端当前每 500 ms 轮询 `/v1/snapshot`；SSE 接口已实现但尚未直接消费。
- 文件模式尚未从压缩会话日志尾读审批与 Job，需要插件桥。
- 悬浮球/面板位置未持久化。
- 暂无 DSH 页面内 `shell.overlay` 浮层。
- 仅支持 Windows。
- 未做代码签名与自动更新。

## 路线图

1. Rust 端直接消费桥接 SSE。
2. 文件模式按帧尾读会话日志，补全审批与 Job。
3. 持久化球/面板位置与多屏偏好。
4. 可选的 DSH 页面内浮层插件。
5. 已签名 NSIS/MSI 安装包与自动更新。

## 贡献

欢迎提交 Issue 和 PR。请保持数据通道只读、不要向协议加入对话正文，并在提交前运行上述检查。

## 许可证

[MIT](LICENSE)
