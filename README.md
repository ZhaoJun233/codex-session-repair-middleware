# Codex 会话资源清理中间件

独立的 Magpie 网关中间件，默认关闭。只清理发往 `/responses` 的请求副本，不读写 Codex 的会话文件、数据库或登录配置，也不依赖 AgentRouter 插件。

**这是有损的兼容模式，不是无损恢复。** 启用后会丢弃加密推理、压缩记录及服务器引用，可能损失重要上下文。优先新建会话，或由客户端补齐完整的可见历史；仅在明确接受损失时启用。

## 安装与开关

需要支持 `magpie.middleware` 和 `ctx.reject` 的 Magpie。本项目按 Magpie `0.1.3906` 的源码接口及其 `moejs 0.1.0` 引擎开发。

克隆仓库后安装整个目录：

```powershell
git clone https://github.com/ZhaoJun233/codex-session-repair-middleware.git
magpie plugin add './codex-session-repair-middleware'
magpie plugin options codex-session-repair-middleware '{"enabled":true}'
```

关闭清理：

```powershell
magpie plugin options codex-session-repair-middleware '{"enabled":false}'
```

也可在 Magpie 的插件设置中修改该中间件的 JSON 选项。只有布尔值 `true` 开启清理；未配置、`false`、`"true"` 或 `1` 都不启用。`package.json` 的 `magpie.options` 只是编辑器示例，实际开关由保存的插件选项决定，不需要重新登录。

如需完全停用或恢复加载：

```powershell
magpie plugin off codex-session-repair-middleware
magpie plugin on codex-session-repair-middleware
```

`on` 只恢复中间件加载，不会把 `enabled:false` 改成 `true`。宿主的内置 `middleware` 功能也必须处于启用状态。配置重载由 Magpie 管理。

Linux/远程服务器同样用 `magpie plugin add /实际目录/codex-session-repair-middleware` 安装整个目录，保留入口文件、`session-repair.mjs` 和 `package.json`。本项目尚未发布到 npm，以上命令不要求 npm 发布。

## 处理规则

| 内容 | 处理 |
| --- | --- |
| 顶层 `previous_response_id` | 对支持的输入移除旧响应关联 |
| 已知消息、工具项的服务器形状 `id` | 移除；消息对应的 `status` 同时移除 |
| 压缩项、服务器引用、资源绑定或加密推理 | 丢弃整项，包括其推理摘要 |
| 已知项的顶层加密或旧响应关联字段 | 移除 |
| 消息中的 `encrypted_content` 片段、仅加密消息 | 丢弃；保留其他片段 |
| 明文、助手 `output_text`、拒绝文本、`phase`、引用标注 | 保留，不转换文本类型 |
| 工具 `call_id`、明文参数、自由格式输入、命名空间、结果 | 保留，不递归修改其中的业务数据 |
| 嵌套业务 ID、附件、未知项及其字段 | 保留 |
| 显式 `conversation`、未知输入结构 | 原样绕过，不重建服务器会话 |
| 没有任何清理变更 | 返回 `undefined`，由宿主保留请求原始字节和 `store` |
| 实际完成清理 | 返回新请求对象，并设置 `store:false` |

服务器形状 ID 的规则为 `/^[a-z][a-z0-9]*_[0-9a-f]{16,}$/i`，只用于已知历史项的顶层 `id`，不遍历全文或附件。

清理后输入为空，或资源绑定的工具项缺少可重放的明文或 `call_id`，会调用宿主的 `ctx.reject(400, message)`，不继续向上游发送。固定中文错误消息不包含请求数据，保留以下识别码前缀：

- `agent_router_session_repair_empty_input`
- `agent_router_session_repair_opaque_tool`

宿主决定 HTTP 错误对象的形状；这里不承诺独立的 `error.code` 字段，也不自动重试。

## 范围与限制

- 仅处理 `ctx.protocol === "responses"` 且路径以 `/responses` 结尾的代理请求。`/responses/compact`、Chat、Anthropic、Gemini 请求绕过；响应及 SSE 不修改。
- 清理发生在供应商选择前，因此不是 AgentRouter 专属开关，会影响所有经过该中间件的 Responses 代理请求。
- 只有经过 Magpie `serveAgent` 的请求会进入该链；宿主自身请求及其他网关入口可能绕过。宿主对旧响应历史的处理发生在中间件之前，若此时已拒绝未知 `previous_response_id`，中间件无法补救。
- 运行于网关内的 moejs，没有网络、文件系统或定时器依赖，不包含登录、文字过滤、其他历史内联逻辑或上游错误诊断。
- 中间件接收宿主解析后的 JSON 对象，没有原始请求头、编码及线上的字节大小信息；请求重新编码由宿主负责。不继承原供应商插件的 4 MiB 检查边界或两秒 Request 克隆期限。
- Magpie 对 `onRequest` 设置 250 ms 执行期限。意外异常或执行超时由宿主记录失败并放行原请求；预期的空输入/工具缺失错误通过 `ctx.reject` 显式拦截。它不是安全隔离或强制过滤器。
- 不建议同时开启原 AgentRouter 插件中的同名清理功能，便于明确清理由哪一层负责；本项目不改变原插件的任何开关或代码。

## 开发验证

运行需要 Node.js 22+；引擎验证额外需要 Go 1.25+。生产中间件不依赖 Node.js 或 Go 开发工具，也没有 npm 运行时依赖。

```powershell
npm test
npm run test:engine
npm run bench:engine
npm pack --dry-run
```

Node 测试检查副本语义、开关、幂等性及打包声明；Go 测试用与宿主相同的 moejs 编译、链接、解析、调用和序列化接口执行相同的合成用例。测试不访问真实会话、账号或上游服务，不等同于远程部署或真实 Codex 会话验证。

清理核心复用 `opencode-agentrouter-auth 0.1.10` 的 `session-repair.mjs`，保留 MIT 许可。发布文件采用显式白名单，不含测试、凭据或本地配置。
