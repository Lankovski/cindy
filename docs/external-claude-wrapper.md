# macOS：使用已有的 Claude wrapper

在启动 Cindy 的进程环境中设置 `CINDY_CLAUDE_EXECUTABLE`，即可使用已有的可执行
Claude wrapper。值必须是绝对路径，支持路径中的空格，不接受 shell alias、函数或命令串。
推荐使用无扩展名或 `.sh` 的 shell wrapper，并用 `exec … "$@"` 转交参数。
SDK 会把 `.js`、`.mjs`、`.ts`、`.tsx`、`.jsx` 入口交给 JavaScript runtime，不能用这些
扩展名命名 shell wrapper。

例如，先完全退出 Cindy，再从终端直接启动应用的可执行文件：

```sh
CINDY_CLAUDE_EXECUTABLE="$HOME/.local/bin/claude" \
  "/path/to/Cindy.app/Contents/MacOS/Cindy"
```

请把应用路径替换为实际构建产物的位置。普通 Finder 双击不会继承终端里临时设置的变量；
已在运行的 Cindy 也不会收到新环境。不要用 `open -a` 代替上面的直接启动方式。

这是进程级开发配置，默认不启用，不写入 Cindy 设置或 Claude 配置。取消该环境变量并
重启 Cindy，即恢复原有的受管理二进制行为。空字符串属于配置错误，不表示取消。

## Claude Code 与 SDK 的分工

本机对话的调用链是 Cindy → `@anthropic-ai/claude-agent-sdk` → wrapper → Claude Code CLI。
Cindy 将 wrapper 路径传入 SDK 的 `pathToClaudeCodeExecutable`；SDK 负责进程控制、流式消息、
会话恢复、权限回调与 MCP 通信。Agent 的运行循环在 Claude Code CLI 中，模型推理由远端
模型服务完成。Cindy 的 `ClaudeCodeAgent` 是会话适配层，还负责拼接产品提示词与限制可用工具。

严格模式下，CLI 通过 SDK/MCP 调用 Cindy 的受限工具，再由独立沙箱进程执行文件、命令和
网页抓取。它并不等于原生 CLI 的默认完整工具配置。另一依赖 `@anthropic-ai/sdk` 是模型 API
客户端，用于宿主 `oneShot` 等辅助请求；这些辅助请求在严格模式下禁用。

## 启用后的行为

- 本地聊天、模型探测、登录状态、登录、用量查询和版本探测使用同一 wrapper 路径。
  Cindy 不解析 wrapper 内部的原生 CLI 路径，也不绕过它。
- 文件不存在、不是普通文件或不可执行时，准备阶段返回错误。不会回退到 Cindy 内置
  Claude；下载、修复及后台更新也不会替换外部入口。
- Claude 使用默认本机订阅登录。外部模式不接受 Cindy 网关、其他供应商或额外的
  Claude 账号目录；旧会话若选了这些来源，需要改选默认 Claude 订阅。
- Cindy 不为此入口添加自己的系统代理桥。wrapper 可以继续设置 `HTTP_PROXY`、
  `HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`、`NODE_OPTIONS`，并通过 `sandbox-exec`
  启动真正的 Claude。wrapper 的配置保持原样；新增的 Cindy 工具沙箱固定使用 7897。
- Codex 的启动与更新方式保持原样。此功能不为远程宿主部署 wrapper，也不覆盖
  其他引擎的工具或网络访问。外部模式仅支持本机 Claude 订阅，远程会话不在支持范围内。

## 严格工具模式

配置外部 wrapper 后自动启用，不提供会话内降级开关。真实 Claude 仍经原 wrapper 启动；
其 OS 沙箱只约束自己的进程树。Cindy 代执行工具通过独立的 `sandbox-exec` 子进程运行，
不会在整个 Cindy 外层嵌套沙箱，也不写入用户的 wrapper、`.sb`、Claude 或防火墙配置。

仅注册 `cindy_restricted` 的六个工具：`read_file`、`write_file`、`edit_file`、`list_files`、
`command`、`web_fetch`。它们通过标准输入输出交换数据。文件工具只接受任务目录内路径；
命令没有持久 shell，最多运行 60 秒，输出最多 2 MiB。文件和网页内容限制为 1 MiB。
网页抓取使用固定 HTTP 代理，不读 `.curlrc`，不自动跟随重定向。

工具进程使用全新的最小环境和临时 HOME；所有代理变量指向 `http://127.0.0.1:7897`，
`NO_PROXY` 为空。Seatbelt 拒绝其它网络，只允许回环 TCP 7897（该 macOS 地址语法包括
IPv4/IPv6 回环）。忽略/清除代理变量不会获得直连权限；不使用宿主通用出网层的直连回退。
无法加载沙箱、代理失败、超时或输出超限均返回工具错误，不转回主进程执行。

写权限仅授予任务目录和单次请求的临时目录，另保护用户配置、运行时代码以及任何
`.git`、`.claude`、`.codex`、`.cindy` 元数据路径。不能以 HOME、文件系统根或其祖先作为
可写任务范围。Git 元数据写入（例如 commit/clone）、后台服务、依赖个人 HOME 的 CLI
登录、Keychain/Mach/Apple Events/桌面自动化不在第一版支持范围内。命令的读取能力仍遵循
操作系统原有文件权限；这不是用于处理不可信文件内容的完整机密数据隔离环境。

严格会话不加载用户/项目设置来源、hooks、插件、额外 MCP 或原生执行工具；原有配置文件
仍保留，普通终端中的 Claude 不受影响。远程/设备托管/伙伴任务拒绝启动。自动记忆、宿主
工具审阅模型、工具循环审阅模型及 `oneShot` 辅助请求禁用。新建、恢复、重建和运行期 flag
settings 更新均保持限制；“完全访问”不能恢复被禁用的工具，也不能越过工具沙箱。

该模式不改动原 wrapper 允许的回环/DNS 例外，不约束其它引擎、Cindy 的独立后台服务或用户
另行启动的软件。Claude CLI 自身继续依赖既有 wrapper/LuLu 保护；不能把工具沙箱的测试结果
扩大成整个应用或任意未来 Claude 版本的网络证明。Claude 版本仍需兼容仓库锁定的 SDK。

## 无真实 Claude 的回归验证

```sh
pnpm --filter desktop exec vitest run \
  src/main/maker-host/__tests__/strict-claude-tools.integration.test.ts \
  src/main/agent-binaries/__tests__/external-claude.test.ts \
  src/main/agent-binaries/__tests__/startup-policy.test.ts \
  src/main/maker-host/__tests__/claudeAuthAdapterOAuthEnv.test.ts \
  src/main/maker-host/__tests__/claudeNativeCli.test.ts \
  src/main/maker-ipc/__tests__/binaryVersionIpc.test.ts
```

`external-claude.test.ts` 在 macOS 创建临时 wrapper、假 CLI、独立 HOME、预加载脚本和
沙箱规则，用仓库锁定的真实 SDK 以及 Cindy 的进程适配器完成初始化。它检查参数、工作
目录、7897 代理环境、凭据清理、预加载，以及沙箱拒绝写入。沙箱禁止所有网络，因此
测试不会连接任何模型服务。真实 SDK 经 mock wrapper 的 MCP 控制消息调用实际受限工具，
验证写入结果。工具集成测试验证直连、其他回环端口、IPv6/UDP、写范围、系统代执行和代理
故障阻断；通过额外拒绝 7897 模拟故障，不停止或修改本机代理。正向抓取测试启动不转发请求的 mock 代理，
仅在测试 spawn 适配器内将生产 7897 地址映射到临时端口，并先断言生产地址。生产代码不提供
代理地址覆盖参数；测试不使用、替换或占用真实代理。

这些测试不会发现或调用机器上真实的 Claude wrapper，也不验证真实账号、代理服务、
LuLu 规则或模型推理是否可用。
