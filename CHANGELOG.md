# Changelog

## 0.2.0

- **Gateway context caps (free DeepSeek group).** When a key's group limits the input per request, Geek2API now reports `context_window` in that key's `/v1/models` (the free DeepSeek group allows 200K although DeepSeek V4.1 Flash itself takes 1M). The catalog model is narrowed to the tightest window reported by the keys that reach it — DeepSeek V4.1 Flash becomes 200K with 32K max output — so DSH compacts the session at about 100K instead of being refused at 200K. Keys whose groups report no cap leave the model unchanged. If a request still overflows, the gateway's error now uses the standard `context_length_exceeded` / `maximum context length` wording, which DSH recognizes and answers by compacting and retrying.
- **Free daily keys.** The free DeepSeek group only accepts the daily key claimed at https://www.geek2api.com/free-ds; each lasts 24 hours and the next one can be claimed 2 hours before expiry (both stay valid). Settings → Geek2API shows each key's expiry, flags a daily key whose renewal window is open or that has expired, and links to the page that issues the next one. The "no usable key" error points there too. A per-request context cap is shown under the key.
- **Custom models.** Settings → Geek2API → Visible models → Custom models adds a model by id next to the built-in catalog: its protocol (Chat Completions, Responses, or Messages), whether it reasons (off / low / medium / high), whether it takes images, and optionally its context window and max output (default 128000 / 32000). It is served by the same route — same keys, endpoints, failover, and key rotation — and appears in the picker at once without restarting. Each key's `/v1/models` coverage includes the custom models (a "Custom" column under the key), so a request for one runs on a key that reaches it. Ids must not repeat a built-in id; at most 32. The list is the volatile `customModels` preference; a hand-edited entry that cannot be served is dropped instead of failing the route. Removing a custom model leaves sessions that used it with an unknown model, never another model. The built-in catalog is unchanged.

## 0.1.4

- Releases are now published to npm automatically from the release workflow through npm trusted publishing (OIDC): the same tarball as the GitHub Release and the Geek2API mirror, with no stored npm token. No plugin behavior changes.

## 0.1.3

- Published to npm as `dsh-geek2api`: the desktop app's Plugins page can install it by name from the official registry. Updates still download from the Geek2API mirror first.
- Added `RELEASING.md`, the release process.

## 0.1.2

- Installs and updates no longer depend on reaching GitHub. Every Geek2API entry point serves a mirror of the releases at `/dsh/` (`latest.json`, each `dsh-geek2api-<version>.tgz`, and `dsh-geek2api.tgz`), synced from GitHub every 10 minutes. The version card asks the mirror first through the endpoint pool and installs the mirrored tarball; GitHub is the fallback. Install address: `https://hk.geek2api.com/dsh/dsh-geek2api.tgz`.

## 0.1.1

- Updates come from GitHub Releases (`CoderKuo/dsh-geek2api`) instead of npm: the version card reads the latest release, links its release notes, and installs its tarball in place for installs from a release tarball (or the npm registry). The release workflow builds, tests, and attaches `dsh-geek2api-<version>.tgz` plus an unversioned `dsh-geek2api.tgz` for a stable install address.
- Keys whose money ran out (wallet `余额不足，请充值`, a lapsed subscription, a subscription window or a key's 5h/1d/7d window) are skipped for 10 minutes instead of being disabled, and come back as soon as a balance read shows money. Previously one empty wallet disabled every key of the account until each was re-enabled by hand. Only the key's own cap (`API key 额度已用完`) and the gateway's own key refusals still disable a key; a bare 401 or generic quota wording passed through from an upstream no longer does.
- `No available accounts` is reported as a busy gateway, not as "no key can use this model".
- Endpoints keep only the origin, so a pasted `https://hk.geek2api.com/v1` no longer doubles every path, and must be https (plain http only on loopback). A timeout no longer sets a host aside, and gateway error text mentioning TLS no longer does either. A hand-edited endpoint list is measured at once.
- Balance: an inactive subscription is shown as such instead of "unrecognized payload"; keys on the same subscription plan count it once; a key quota is shown as a cap (it spends the wallet) and left out of the total; 5h/1d/7d windows are shown.
- Fixed the endpoint list editor emptying itself after Save (a second Save then restored the defaults); an empty list can no longer be saved, use Restore defaults instead.
- Fixed the endpoint list editor in Settings → Geek2API → Endpoints being only about 20 characters wide: it now spans the card, grows with the list, and resizes vertically.

## 0.1.0

First release. Derived from [dsh-packycode-api](https://github.com/BaronCyrus/dsh-packycode-api) 1.1.7 (MIT) and rebuilt for the Geek2API gateway (sub2api).

- **Route and catalog.** A self-contained `Geek2API` model route with 13 models, each pinned to the protocol its vendor serves on this gateway: Claude Opus 5.5, Claude Sonnet 5.5, and Claude Haiku 4.5 on Messages; GPT-6.1 Sol, GPT-6 Astra, GPT-6 Luna, Grok 4.6, and Grok 4.7 on Responses; DeepSeek V4.1 Flash, DeepSeek V4 Pro, Gemini 3.8 Flash, GLM-5.3, and Kimi K3 on Chat Completions. Gemini, GLM, and Kimi are declared without reasoning control; the route asks them for `off` so the profile's default effort never refuses them.
- **Multi-endpoint failover.** The built-in endpoints are `hk`, `hk2`, `hk3`, `hk4`, and `www` `.geek2api.com`. They are ranked by `/health` latency (re-measured every 10 minutes and on demand). A host that fails in transit — DNS, TLS, connect timeout, reset — is passed over for two minutes, and the harness's retry of the step lands on the next one. Balance, model-list, and search reads fail over the same way. The list is editable in Settings → Geek2API → Endpoints.
- **Balance.** Read from `/v1/usage` per key, covering the three shapes sub2api answers: wallet, subscription (the tightest daily/weekly/monthly window), and per-key quota (with 5h/1d/7d windows). Today's spend is shown per key.
- **Per-key models.** Each key's `/v1/models` decides which catalog models it reaches (✓/✕ per family). Group names are shown when `/v1/usage` reports them. A key whose group was deleted or withdrawn (`API Key 所属分组已删除`) is recognized as rejected.
- **Key rotation.** sub2api's own wording moves a key aside: `Invalid API key`, `API key is disabled`, `API key 已过期`, `余额不足，请充值`, `No active subscription`. A request for a model none of the stored keys can use (`Model 'x' is not available`) is explained instead of retried; HTTP 400 is no longer retryable.
- **Claude runtime.** Claude models call the Messages API directly by default (DSH's own tools, permissions, and plan mode). Settings → Geek2API → Claude runtime switches them to the local Claude Code CLI, which keeps the CLI adapter, MCP web search bridge, and plan-mode handoff of the original. The `claude_code` delegation tool is unchanged.
- **Web search.** Same design as the original, routed through the profile patch, with backends Claude (`claude-haiku-4-5-20251001`, Messages + `web_search_20250305`, the default, about 8.5K input tokens per search) and GPT (`gpt-6.1-sol`, Responses + `web_search`). The DeepSeek backend is dropped: this gateway's DeepSeek groups ignore the server tool and answer without searching.
- **Lighter balance reads.** Balance and group reads call `/v1/usage?lite=1`, which skips the per-day and 30-day model statistics on gateways that support it; older gateways ignore the parameter.
