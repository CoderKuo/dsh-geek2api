# 发版流程

dsh-geek2api 通过 **GitHub Release** 发布，不发布到 npm。推送 `v*` tag 后由 GitHub Actions 自动测试、打包、创建 Release；Geek2API 各入口的 `/dsh/` 镜像会在 10 分钟内自动同步，已安装的插件随后就能在设置页一键更新。

## 发布链路

```text
git push tag v<版本>
  └─ .github/workflows/release.yml
       ├─ 校验 tag 与 package.json 版本一致
       ├─ pnpm run check（全部测试 + 构建 + 打包）
       ├─ 校验已提交的 lib/ 与重新构建的结果一致
       └─ 创建 Release，附件：
            dsh-geek2api-<版本>.tgz   （带版本号，插件更新时安装它）
            dsh-geek2api.tgz          （固定文件名，用作安装地址）
                    │
                    ▼  每 10 分钟同步
  Geek2API 镜像 https://hk.geek2api.com/dsh/
       ├─ latest.json                 （version / tarball / sha256 / releaseUrl）
       ├─ dsh-geek2api-<版本>.tgz     （每个版本都保留）
       └─ dsh-geek2api.tgz            （最新版）
                    │
                    ▼
  插件「插件版本」卡片：先读镜像 latest.json，读不到再查 GitHub releases/latest
                       → 点「更新插件」安装对应的 .tgz
```

国内直连下载不了 GitHub Release 附件，镜像就是为此准备的；能访问 GitHub 时，两边内容完全一样。

## 发版步骤

### 1. 确认工作区干净、版本号没用过

```sh
git status --short --branch
git fetch origin --tags
git ls-remote --exit-code --tags origin refs/tags/v<版本>   # 应当失败（tag 不存在）
```

版本号按 SemVer：只修 bug 升 patch（0.1.2 → 0.1.3），加功能升 minor（0.1.x → 0.2.0）。

### 2. 改版本号和更新记录

- `package.json` 的 `version`
- `CHANGELOG.md` 顶部加一节 `## <版本>`，写清楚这一版改了什么

**CHANGELOG 里这一节的内容会原样作为 Release 说明**，用户在设置页点「更新说明」看到的就是它。标题必须是 `## 0.1.3` 这种格式，后面不要加别的字。

### 3. 本地验证并重新构建

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`lib/` 是提交到仓库里的构建产物，改了 `src/` 一定要重新构建并一起提交，否则 CI 会因为「lib/ 与重新构建结果不一致」而失败。

Windows 上有 12 个测试会因为环境原因失败（没有创建 symlink 的权限、测试用的伪 CLI 是 shell 脚本），属于已知情况；CI 在 Linux 上会全部通过。只想在本地打包时可以跳过测试：

```sh
pnpm run build && pnpm pack --pack-destination .artifacts
```

需要验证真实网关时（改了模型清单、协议、失败分类、多入口逻辑时应当跑）：

```sh
node scripts/smoke.mjs <keys.json>    # keys.json 形如 {"备注": "sk-…"}，只打印备注
```

### 4. 提交并推送 main

```sh
git add -A
git commit -m "release: <版本>"
git push origin main
```

等 CI 通过（`gh run list --limit 3`）再继续。

### 5. 打 tag 并推送，触发发布

```sh
git tag -a v<版本> -m "dsh-geek2api v<版本>"
git push origin v<版本>
```

查看发布进度：

```sh
gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
gh release view v<版本> --json assets --jq '[.assets[].name]'
# 应当看到 dsh-geek2api-<版本>.tgz 和 dsh-geek2api.tgz
```

### 6. 确认镜像已同步

镜像最多 10 分钟内同步：

```sh
curl -s https://hk.geek2api.com/dsh/latest.json
```

`version` 变成新版本即可。确认后，已安装的插件在设置页「插件版本」卡片点「检查更新」就能看到新版本。

## 规则

- **已发布的 tag 和 Release 附件不能改、不能删、不能移动。** 发现问题就发一个新的 patch 版本。
- 发版是对外可见的操作：已安装的用户会收到更新提示。
- 不要在 Release 附件或仓库里放任何 API Key、凭据。
- 默认接口地址只能是 geek2api.com 的入口。

## 出问题时

| 现象 | 原因与处理 |
| --- | --- |
| Release 流程报 `tag vX does not match package.json` | tag 与 `package.json` 版本不一致。删掉本地和远端这个 tag（Release 还没创建，可以删），改好版本号重新打 |
| Release 流程报 `git diff --exit-code -- lib/` 失败 | 改了 `src/` 没重新构建。执行 `pnpm run build`，提交 `lib/`，换一个新版本号重新发 |
| 测试失败 | 在 Linux 上复现并修复，换一个新版本号重新发 |
| Release 有了，但镜像 `latest.json` 一直是旧版本 | 镜像同步还没跑到（最多 10 分钟）；超过 15 分钟请联系运维检查源站的同步任务 |
| 用户点「更新插件」失败 | 先确认镜像里有对应版本的 `.tgz`；用户可以在插件页用安装地址重新安装 |

## 安装地址（给用户）

```text
https://hk.geek2api.com/dsh/dsh-geek2api.tgz
```

`hk` 可以换成 `hk2` / `hk3` / `hk4`。能访问 GitHub 的用户也可以用：

```text
https://github.com/CoderKuo/dsh-geek2api/releases/latest/download/dsh-geek2api.tgz
```
