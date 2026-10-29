<h1 align="center">LCU Auto</h1>
<p align="center">让 MCP 客户端使用电脑操作工具，不再依赖客户端专用的 App 授权弹窗。</p>
<p align="center"><a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a></p>
<p align="center"><a href="#安装">安装</a> · <a href="#第一次连接">第一次连接</a> · <a href="#共享后台">共享后台</a> · <a href="./docs/README.md">文档</a></p>

```sh
lcu-auto mcp
```

把已安装的 [LCU Runtime](https://github.com/amontlabs/lcu) 暴露为本地 MCP 服务。需要本地客户端和远程客户端共用后台时，改用 `lcu-auto mcp --url http://127.0.0.1:8789/mcp`。

**当前为早期 0.x 版本。** 本包提供适配层，不提供桌面执行引擎；需要单独安装上游 LCU 及其要求的官方 ChatGPT 桌面应用。原生 App 授权由本地自动回答：默认选择 Runtime 提供的 **Always allow**，可能形成持久授权。仅向你信任的客户端开放。

## 为什么需要它

有些 MCP 客户端能够调用工具，却无法显示 LCU 的 App 授权交互。远程客户端还可能每次调用都重新建立 MCP 连接，导致 JavaScript 变量丢失，或不断占用新的执行进程。

LCU Auto 在本地处理识别出的原生 App 授权，让相关调用复用电脑操作状态，并把工具发现与真正的桌面执行分开。只提供 `js` 和 `js_reset`；是否批准工具调用，仍由你的客户端决定。

## 安装

需要 **Node.js 22.14 或更新版本**及用于源码构建的 **Bun 1.4.3**。全局 shim 和后台服务均使用 Node 执行构建后的 `dist/cli.js`，不依赖 Bun 或 TypeScript 入口。

**npm 发布暂缓。** 当前按下面的源码方式安装；tag 驱动发布流程已准备，但不能把它当成已经存在的 registry 版本。

```sh
git clone https://github.com/yoyooyooo/lcu-auto.git
cd lcu-auto
bun install --frozen-lockfile
bun run build
bun run shim:install
lcu-auto --version
lcu-auto doctor
```

`doctor` 只检查是否找到已安装的 LCU adapter，不会点击应用、授予系统权限，也不能代替截图实测。成功时会显示 `LCU adapter found`。

按照[上游安装文档](https://github.com/amontlabs/lcu/blob/main/docs/INSTALLATION.md)准备 Runtime 与系统权限。macOS 默认查找 `~/.local/share/lcu`，Linux 默认 `/opt/lcu`；其他位置使用 `--lcu-dir` 或 `LCU_AUTO_PREFIX`。既可传包含 `current/` 的安装前缀，也可传包含 `adapters/` 的 release 目录。

### 平台边界

CLI 使用 Node.js 和平台适配路径。CI 在 macOS、Linux、Windows 上运行协议、配置、包安装与 CLI 检查；用户服务定义分别对应 launchd、systemd 和 Windows 计划任务。

**桌面控制是另一层依赖。** 上游 LCU 列出的平台是 Apple Silicon macOS 与兼容的 Linux/X11 桌面；Windows 仍是候选，不是本版本已支持的桌面后端。本项目真实桌面验收在 Apple Silicon macOS 完成，不宣称已经实测 Linux 桌面或非 macOS 服务安装。详见[兼容性](docs/compatibility.md)。

## 第一次连接

在 MCP 客户端中添加 stdio 服务：

```json
{
  "mcpServers": {
    "lcu-auto": {
      "command": "lcu-auto",
      "args": ["mcp"]
    }
  }
}
```

shim 写入 `~/.local/bin`（Windows 为 `%LOCALAPPDATA%\lcu-auto\bin`），必要时把该目录加入 PATH。GUI 客户端没有继承 shell 的 `PATH` 时，改填已安装命令的绝对路径。连接后应当恰好出现 **`js`** 和 **`js_reset`**。`mcp` 不输出欢迎文本，因为 stdout 只承载 MCP 消息。

先让客户端选择无敏感内容的测试应用、读取状态，再用下一次独立调用输入，并核对实际界面。不要一开始就测试聊天发送、账号设置或重要文档。

LCU 的工具说明会提供 `cua` API。第一次 `js` 选择应用或读取列表，后续调用可以复用绑定。这里只自动处理识别出的原生 App 授权，未知请求取消，上游宿主应用限制和操作系统权限仍然保留。

## 共享后台

共享后台让本地和远程客户端使用同一个桌面操作队列。先创建本机凭据并启动服务：

```sh
lcu-auto token
lcu-auto serve
```

在另一个终端，或 MCP 客户端的命令配置中连接它：

```sh
lcu-auto mcp --url http://127.0.0.1:8789/mcp
```

凭据从本机配置目录读取，不写进 MCP 配置、不打印内容。全部 HTTP 路由需要认证，服务只监听 loopback。

需要随用户登录启动时，显式安装用户服务：

```sh
lcu-auto service install
lcu-auto service start
lcu-auto service status
```

安装不会立即启动。先停止已有前台 server，再启动受管服务。有客户端时，`stop` 和 `restart` 默认拒绝断开，除非显式使用 `--force-disconnect`。服务定义指向当前安装的 CLI；移动安装位置后需要重新安装定义。[服务管理文档](docs/services.md)说明平台限制与恢复方式。

### 远程访问

通过 Cloudflare named tunnel 和 Access Managed OAuth 接入，再使用 Access 配置文件启动后台。源站会验证签名后的 Access assertion，不相信单独的邮箱 header。本机 bearer token 不能认证发往公网 hostname 的请求。

按照[远程部署指南](docs/deployment.md)配置前提、OAuth 发现、回调、源站校验和验证。**只有 tunnel 不等于有认证。** 安装 npm 包不会自动创建隧道、账号策略或 DNS。

## 状态与安全

连续调用保留同一个电脑操作 control turn，成功返回不会立即清理。面对 ChatGPT 式短连接，后台按“已认证身份 + 不透明对话标识”关联状态；对话标识不是认证凭据。普通客户端仍使用连接级状态。

工具发现不占执行 Runtime。空闲执行上下文有数量限制并会回收，正在执行的动作不会被驱逐。取消、重置和退出会先清理，再放行队列中的后续操作。超时或丢失响应不代表动作没有发生，重试前先观察桌面。

队列只串行化单次调用，不把整个多步任务变成事务。不要让两个 Agent 同时修改一个窗口。截图和可访问性文本可能包含隐私，会返回给 MCP 客户端。本包不发送遥测，生产日志不保存工具结果；上游 LCU 和客户端有各自的行为与条款。

默认 `--scope always` 可能在上游保存持久 App 授权。`--scope session` 或 `--scope once` 限制新请求的最长授权范围，不撤销旧授权。浏览器扩展接口需要显式开启并逐个给出完整站点 origin。详见[安全模型](docs/security-model.md)。

## 命令与开发

公开命令为 `mcp`、`serve`、`token`、`doctor`、`config paths` 和 `service`。使用 `lcu-auto <命令> --help` 查看参数、补全和错误。旧 `connect`、`stdio`、`http` 保留为迁移别名，新配置统一使用 `mcp` 和 `serve`。

```sh
bun install --frozen-lockfile
bun run check
bun run pack:check
```

默认测试不需要已安装的 LCU、图形桌面、云账号或私人凭据；真实桌面测试是独立的显式入口。[贡献指南](CONTRIBUTING.md)说明检查方法与双语同步责任，[发布文档](docs/releases.md)说明不可变 tag 和 npm trusted publishing。

[CLI 参考](docs/cli.md) · [故障排查](docs/troubleshooting.md) · [架构](docs/design.md) · [更新记录](CHANGELOG.md) · [私下报告漏洞](SECURITY.md)

MIT 许可证。本项目不隶属于 OpenAI 或 Amont Labs。LCU 单独安装，不随包分发专有桌面 Runtime。参见[第三方声明](THIRD_PARTY_NOTICES.md)。
