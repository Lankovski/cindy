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

## 启用后的行为

- 本地聊天、模型探测、登录状态、登录、用量查询和版本探测使用同一 wrapper 路径。
  Cindy 不解析 wrapper 内部的原生 CLI 路径，也不绕过它。
- 文件不存在、不是普通文件或不可执行时，准备阶段返回错误。不会回退到 Cindy 内置
  Claude；下载、修复及后台更新也不会替换外部入口。
- Claude 使用默认本机订阅登录。外部模式不接受 Cindy 网关、其他供应商或额外的
  Claude 账号目录；旧会话若选了这些来源，需要改选默认 Claude 订阅。
- Cindy 不为此入口添加自己的系统代理桥。wrapper 可以继续设置 `HTTP_PROXY`、
  `HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`、`NODE_OPTIONS`，并通过 `sandbox-exec`
  启动真正的 Claude。Cindy 不硬编码 7897；该端口仍由 wrapper 管理。
- Codex 的启动与更新方式保持原样。此功能不为远程宿主部署 wrapper，也不覆盖
  Cindy 主进程执行的工具或网络访问。外部模式仅支持本机 Claude 订阅，远程会话不在支持范围内。

Claude 仍按现有 SDK 参数读取用户设置、hooks 和插件；Cindy 原有的工作区设置检查仍然
生效。wrapper 的 OS 沙箱只约束它启动的进程树，不等于整个 Cindy 都进入同一沙箱。
Claude 版本仍需兼容仓库锁定的 Agent SDK。登录时是否能打开浏览器取决于 wrapper 的策略。

## 无真实 Claude 的回归验证

```sh
pnpm --filter desktop exec vitest run \
  src/main/agent-binaries/__tests__/external-claude.test.ts \
  src/main/agent-binaries/__tests__/startup-policy.test.ts \
  src/main/maker-host/__tests__/claudeAuthAdapterOAuthEnv.test.ts \
  src/main/maker-host/__tests__/claudeNativeCli.test.ts \
  src/main/maker-ipc/__tests__/binaryVersionIpc.test.ts
```

`external-claude.test.ts` 在 macOS 创建临时 wrapper、假 CLI、独立 HOME、预加载脚本和
沙箱规则，用仓库锁定的真实 SDK 以及 Cindy 的进程适配器完成初始化。它检查参数、工作
目录、7897 代理环境、凭据清理、预加载，以及沙箱拒绝写入。沙箱禁止所有网络，因此
测试不会连接本机 7897 或任何模型服务。其余用例模拟二进制、网络和账号存储。

这些测试不会发现或调用机器上真实的 Claude wrapper，也不验证真实账号、代理服务、
LuLu 规则或模型推理是否可用。
