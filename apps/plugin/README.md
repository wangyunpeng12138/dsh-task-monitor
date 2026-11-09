# @dsh-monitor/bridge

DSH Host 插件：把当前 Host 中活跃 Session 的事件折叠为任务快照，在本机回环端口提供：

- `GET /v1/health`
- `GET /v1/snapshot`
- `GET /v1/events`（SSE）
- `POST /v1/actions/cancel-turn`
- `POST /v1/actions/cancel-job`（取决于 Host 是否提供 Job kill）

## 安装

本地 link（开发期）：

```powershell
dsh plugin --profile desktop add "link:$((Resolve-Path .)\apps\plugin)"
```

之后在 DSH 的 Settings → Plugins 中启用 **DSH Task Monitor bridge**。
`dsh plugin add` 只装包；bundle 选择由插件管理页/`plugin_manager` 完成。

## 配置

`cordis.patch.yml` 已给出默认值，也可在用户补丁层覆盖：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `0` | 0 = 系统分配；仅绑定 `127.0.0.1` |
| `coalesceMs` | `150` | 事件合并窗口 |
| `maxTasks` | `30` | 单实例最大任务数 |

## 工作方式

- 启动时读取 `ctx.sessionProjections.snapshot(session)` 播种每个活跃会话；
- 订阅 `session/event`、`agent/status`、`session/created|disposed`；
- 折叠 `turn/*`、`step/*`、`todo/write`、`job/*`、`approval/*`、`goal/change` 等事件；
- 写入发现文件并等待悬浮端连接；
- 不写 Session、不新增事件类型、不持久化监控状态。

## 测试

```powershell
pnpm --filter @dsh-monitor/bridge test
```

## License

[MIT](../../LICENSE)
