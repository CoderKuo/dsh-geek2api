<div align="center">

<img src="docs/assets/dsh-geek2api-mascot.png" width="200" height="200" alt="Geek2API">

# DSH Geek2API

[简体中文](README.md) · **English**

**Use Geek2API API keys in DeepSeek Harness: pick models, rotate keys, see balances.**

Installing it adds a `Geek2API` group to the model picker. No YAML and no provider setup.

</div>

## Features

| Capability | What you get |
| --- | --- |
| **Built-in model route** | A `Geek2API` picker group with Claude, GPT, DeepSeek, Grok, Gemini, GLM, and Kimi |
| **Multi-endpoint failover** | The hk / hk2 / hk3 / hk4 / www entry points are measured and the fastest is used; one that cannot be reached is skipped and the retry goes to the next |
| **Several keys in order** | An exhausted, disabled, or rejected key hands over to the next usable key |
| **Per-key model choice** | Each key lists the models it can use (✓ / ✕); a turn whose model the active key cannot use runs on a key that can |
| **Balances at a glance** | Remaining balance, today's spend, subscription window or key quota per key; keys of one account share a wallet and count once; the composer shows the active key's remaining balance |
| **Two Claude runtimes** | HTTP by default (DSH's own tools and permissions), or the local official Claude Code CLI |
| **Optional web search** | DSH's `web_search` can search through Geek2API (Claude or GPT backend) |
| **Credentials stay local** | Keys live only in the DSH credentials file; the browser sees labels, state, and balances |

## Install

1. In the desktop app, open **Plugins → Add plugin**, enter `https://github.com/CoderKuo/dsh-geek2api/releases/latest/download/dsh-geek2api.tgz`, and install. No restart is needed for a first install. You can also download the `.tgz` from [Releases](https://github.com/CoderKuo/dsh-geek2api/releases) and install it from a local path.
2. Open **Settings → Geek2API** and paste an API key (create one under API Keys in the Geek2API console). Add more keys for other groups; the plugin picks the right one per model.
3. Pick a model under the `Geek2API` group.

## Daily use

- **Models per key.** Under each key, ✓ / ◐ / ✕ per model family, read from that key's `/v1/models` (free). When no stored key can use the selected model the turn says so instead of retrying.
- **Balance.** Wallet (shared by an account's keys, counted once), the tightest subscription window, or the key's own quota and 5h/1d/7d windows, plus today's spend. Refresh skips the 60-second cache.
- **Endpoints.** The Endpoints card shows each entry point's latency and state. Hosts are re-measured every 10 minutes; a host that fails in transit (DNS, TLS, timeout, reset) is skipped for 2 minutes and the failed step retries on the next one. You can re-measure or edit the list (one per line; empty restores the defaults).
- **Claude runtime.** In the Claude Code CLI card: HTTP (default, recommended) or the local Claude Code CLI (one-click install; needs Node.js 18+, and Git for Windows on Windows). The `claude_code` delegation tool works either way.
- **Web search.** Settings → Geek2API → Web search: leave DSH alone (default), search through Geek2API for Geek2API models only, or always. Backend: Claude (`claude-haiku-4-5-20251001`, default, about 10K tokens per search) or GPT (`gpt-6.1-sol`, about 20–30K). DeepSeek groups drop the server search tool, so they are not offered.

Keys rotate on `余额不足，请充值`, a lapsed subscription, `Invalid API key`, `API key is disabled`, `API key 已过期`, or `API Key 所属分组已删除`. Rate limits (429) and upstream 5xx do not rotate keys; they are retried.

## Models

| Model | Protocol | Efforts |
| --- | --- | --- |
| `claude-opus-5-5`, `claude-sonnet-5-5` | Messages | low / medium / high / xhigh / max |
| `claude-haiku-4-5-20251001` | Messages | low / medium / high |
| `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-luna` | Responses | low / medium / high / xhigh / max |
| `deepseek-v4.1-flash`, `deepseek-v4-pro` | Chat Completions | off; low / high / max |
| `grok-4.6`, `grok-4.7` | Responses | low / medium / high / xhigh |
| `gemini-3.8-flash`, `glm-5.3`, `kimi-k3` | Chat Completions | none |

Whether a key can use a model depends on its group; trust the ✓ / ✕ in settings.

## Update and uninstall

The version card in **Settings → Geek2API** checks the latest GitHub release; update from there, then fully quit and reopen the desktop app. Before uninstalling, set web search back to "leave DSH alone" if you used it, then uninstall from the Plugins page and restart.

## Security

Requests go to Geek2API's endpoints. Keys are stored in `~/.dsh/.credentials.yaml` (owner-only) and never reach settings documents, logs, transcripts, or the browser. Balance and model-list reads are host-side, time-bounded, and refuse redirects. See [SECURITY.md](SECURITY.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm run check
node scripts/smoke.mjs keys.json   # {"label": "sk-…"}; prints labels only
```

Derived from [dsh-packycode-api](https://github.com/BaronCyrus/dsh-packycode-api) (MIT). License: [MIT](LICENSE).
