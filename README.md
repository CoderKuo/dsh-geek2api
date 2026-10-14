<div align="center">

<img src="docs/assets/dsh-geek2api-mascot.png" width="200" height="200" alt="Geek2API">

# DSH Geek2API

**简体中文** · [English](README.en.md)

**用 Geek2API 的 API Key，在 DeepSeek Harness 里选模型、轮换 Key、看余额。**

安装后模型选择器里自带 `Geek2API` 分组，不用改 YAML，也不用另配 provider。

[功能](#功能) · [安装](#安装) · [日常使用](#日常使用) · [模型](#模型) · [常见问题](#常见问题)

</div>

## 功能

| 能力 | 使用体验 |
| --- | --- |
| **自带模型路由** | 模型选择器出现 `Geek2API` 分组，Claude、GPT、DeepSeek、Grok、Gemini、GLM、Kimi 都在里面 |
| **多接口地址自动切换** | 内置 hk / hk2 / hk3 / hk4 / www 多个入口，按测速结果选最快的；某个入口连不上自动换下一个，对话不中断 |
| **多 Key 按顺序使用** | Key 余额用尽、被停用或失效时自动切到下一个可用 Key |
| **按 Key 自动选模型** | 每个 Key 后面列出它能用哪些模型（✓ / ✕）；当前 Key 用不了所选模型时，这一轮自动改用能用的 Key |
| **余额一眼可见** | 设置页列出每个 Key 的剩余额度、今日消费、订阅周期或 Key 限额；同一账户的 Key 共用钱包，合计只算一次；输入框右侧显示当前 Key 的剩余额度 |
| **Claude 两种运行方式** | 默认直接走 HTTP（用 DSH 自己的工具和权限）；也可以切换成本机官方 Claude Code CLI 执行 |
| **网页搜索可走 Geek2API** | 可选：DSH 的 `web_search` 改用 Geek2API 的 Claude 或 GPT 搜索 |
| **凭据不离开本机** | Key 只存在 DSH 凭据文件里，浏览器只能看到备注、状态和余额 |

## 安装

先准备好 **DeepSeek Harness** 桌面应用和 **Geek2API 的 API Key**（在 Geek2API 控制台「API 密钥」页创建）。

### 1. 安装插件

打开桌面应用的**插件**页，点击**添加插件**，在**包名或地址**中填入包名，**安装源**选**官方源**：

```text
dsh-geek2api
```

然后点击**安装**。首次安装后不用重启 DSH。

> 新版本发布后的 24 小时内，DSH 的包管理器会拒绝按包名安装（报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。这时改用下面的镜像地址即可；已安装的插件在设置页「更新插件」不受这个限制。

也可以填安装地址：

```text
https://hk.geek2api.com/dsh/dsh-geek2api.tgz
```

这是 Geek2API 自己的镜像，国内直连就能下载，内容与 GitHub Release 相同（每 10 分钟同步一次）；hk2 / hk3 / hk4 换掉域名里的 `hk` 也可以。能访问 GitHub 的话，也可以填 `https://github.com/CoderKuo/dsh-geek2api/releases/latest/download/dsh-geek2api.tgz`，或从 [Releases](https://github.com/CoderKuo/dsh-geek2api/releases) 下载后填本地文件路径。

### 2. 添加 Key

打开 **设置 → Geek2API**，在「添加 Key」里粘贴 API Key，备注可选。可以添加多个 Key，例如一个 Claude 分组的 Key、一个 GPT 分组的 Key，插件会按模型自动选用。

> 不要把 Key 粘贴到公开的地方。插件不会读取环境变量，也不会在失败时偷偷改用别的 provider。

### 3. 选择模型

回到对话，在模型选择器里选 `Geek2API` 分组下的模型即可。

## 日常使用

**看能用哪些模型。** 「账户与 Key」里每个 Key 下面列出能用的模型族：✓ 可用、◐ 部分可用、✕ 不可用。这个结果直接来自该 Key 的 `/v1/models`，不产生费用。选了某个 Key 用不了的模型时，插件会自动换一个能用的 Key；所有 Key 都不能用时，会直接告诉你，而不是反复重试。

**看余额。** 每个 Key 会显示：

- 钱包余额（同一账户的所有 Key 共用，合计只算一次）；
- 订阅分组的当前周期额度（日 / 周 / 月中最紧的那个）；
- 或者 Key 自己的限额，以及 5 小时 / 1 天 / 7 天限速窗口。

另外显示今日在这个 Key 上的消费。「刷新」会跳过约 60 秒的缓存。

**接口地址。** 「接口地址」卡片列出每个入口的延迟和状态。插件每 10 分钟测一次速，所有请求用最快的入口；某个入口出现连接失败（DNS、TLS、超时、断连）会被跳过 2 分钟，失败的那一步自动在下一个入口上重试。可以点「重新测速」，也可以编辑地址列表（每行一个，留空恢复默认）。

**换 Key。** Key 按添加顺序使用。「切到此 Key」指定优先使用的 Key；「重命名」改备注；充值或更换后点「重新启用」。

**Claude 运行方式。** 在 **设置 → Geek2API → Claude Code CLI** 卡片里切换：

| 方式 | 说明 |
| --- | --- |
| HTTP 直连（默认，推荐） | Claude 模型直接调用 Geek2API 的 Messages 接口，使用 DSH 自己的工具、权限和计划模式 |
| 本机 Claude Code CLI | 由本机官方 CLI 执行这一轮，使用 CLI 自己的工具；需要先安装 CLI（卡片里可以一键安装，需要 Node.js 18+，Windows 另需 Git for Windows） |

无论选哪种，`claude_code` 委派工具都可以把一个任务交给本机 Claude Code 去做。

**网页搜索。** DSH 的 `web_search` 默认调用 DeepSeek 官方接口。在 **设置 → Geek2API → 网页搜索** 可以改走 Geek2API：

| 搜索路由 | 效果 |
| --- | --- |
| 不接管（默认） | 不改 DSH 的搜索设置 |
| 按模型 | Geek2API 模型用 Geek2API 搜索，其他模型照旧 |
| 始终 Geek2API | 原本走 DSH 默认搜索的请求都改走 Geek2API |

搜索后端可选 Claude（`claude-haiku-4-5-20251001`，默认，每次约 1 万 token）或 GPT（`gpt-6.1-sol`，每次约 2–3 万 token）。DeepSeek 分组不支持服务端搜索工具，所以不提供。一次搜索就是一次带搜索工具的模型调用，按正常价格计费。

<details>
<summary>什么时候会自动切换 Key</summary>

- **会切换并停用当前 Key：** 余额不足（`余额不足，请充值`）、订阅失效、Key 被拒绝（`Invalid API key`、`API key is disabled`、`API key 已过期`、`API Key 所属分组已删除`）。失败的那一步由重试接手，从而用上新 Key。
- **按模型改用，不停用：** 当前 Key 的模型列表里没有这一轮的模型、而另一个 Key 有时，这一轮直接用那个 Key。「使用中」的 Key 不变。
- **不会切换：** 限速（429）、上游暂时不可用（5xx，会自动重试）。
- 全部 Key 都停用时，请求失败并说明没有可用 Key，不会回退到别的凭据。

</details>

## 模型

| 模型 | 协议 | 推理档位 |
| --- | --- | --- |
| `claude-opus-5-5` | Messages | `low` / `medium` / `high` / `xhigh` / `max` |
| `claude-sonnet-5-5` | Messages | 同上 |
| `claude-haiku-4-5-20251001` | Messages | `low` / `medium` / `high` |
| `gpt-6.1-sol` | Responses | `low` / `medium` / `high` / `xhigh` / `max` |
| `gpt-6-astra` | Responses | 同上 |
| `gpt-6-luna` | Responses | 同上 |
| `deepseek-v4.1-flash` | Chat Completions，可带图 | 可关；`low` / `high` / `max` |
| `deepseek-v4-pro` | Chat Completions | 同上 |
| `grok-4.6` | Responses | `low` / `medium` / `high` / `xhigh` |
| `grok-4.7` | Responses | 同上 |
| `gemini-3.8-flash` | Chat Completions，可带图 | 无 |
| `glm-5.3` | Chat Completions | 无 |
| `kimi-k3` | Chat Completions，可带图 | 无 |

列表里看得到模型，不代表你的 Key 一定能用：能不能用取决于 Key 所在的分组，以设置页的 ✓ / ✕ 为准。设置页「显示的模型」可以隐藏用不到的模型。

## 更新与卸载

**更新：** 打开 **设置 → Geek2API**，「插件版本」卡片会先从 Geek2API 镜像检查最新版本（国内直连可用），镜像不可用时再查 GitHub；有新版本时点「更新插件」，完成后完全退出并重新打开桌面应用。「更新说明」链接到这个版本的发布页。

**卸载：** 用过 Geek2API 网页搜索的话，先在 **设置 → Geek2API → 网页搜索** 切回「不接管」，再到**插件**页卸载，然后重启桌面应用。否则 `cordis.patch.yml` 里会留下指向已卸载后端的配置；这时手动删掉带 `dsh-geek2api: web search provider` 标记的那一段即可。

## 常见问题

**某个模型不可用，但 Key 是有效的？** 看「账户与 Key」里这个 Key 的 ✓ / ✕。分组不提供这个模型时，添加一个对应分组的 Key，插件会自动用它。

**余额显示的和控制台不一样？** 钱包余额是账户级的，同一账户的多个 Key 显示同一个数，合计只算一次。Key 设置了限额时显示的是这个 Key 的剩余限额。

**某个接口地址一直显示不可达？** 可能是你所在网络到这个入口不通，插件会自动跳过它，其他入口正常就不影响使用。全部不可达时请检查网络或代理。

**选了 Claude 模型一直不出字？** 如果运行方式是「本机 Claude Code CLI」，先看思考区：只有「▸ 启动 Claude Code CLI…」说明本机 CLI 没起来（Windows 上先确认装了 Git for Windows，并在终端执行 `claude --version`）。改回「HTTP 直连」可以绕过 CLI。

## 安全边界

本项目与 DeepSeek 无隶属关系。模型请求会发到 Geek2API 的接口；凭据不返回浏览器，不代表推理在本地完成。

Key 存在本机 DSH 凭据文件（`~/.dsh/.credentials.yaml`，仅所有者可读），不进设置文档、日志或对话记录。余额和模型列表请求只在宿主侧发出，带超时并禁止重定向。更多说明见 [SECURITY.md](SECURITY.md)。

## 本地开发

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` 会跑全部测试、重新构建，并在 `.artifacts/` 打出 tarball。`lib/` 是已提交的构建产物，改 `src/` 后用 `pnpm run build` 生成，不要手改。

真机验证：`node scripts/smoke.mjs <keys.json>`，`keys.json` 形如 `{"备注": "sk-…"}`。脚本会测速各入口、读每个 Key 的余额和可用模型，并让每个模型回答一次，只打印 Key 的备注。

## 致谢

基于 [dsh-packycode-api](https://github.com/BaronCyrus/dsh-packycode-api)（MIT）改写。

## License

[MIT](LICENSE)
