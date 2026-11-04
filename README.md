# ACLClouds 自动续期 (Node.js + Playwright)

为 [ACLClouds](https://aclclouds.com) 免费 Discord Bot 服务器（Free 档，4 天一续）做的自动续期。浏览器登录 + 浏览器续期，到期时间从页面读取。

## 原理

1. 登录：注入 `COOKIE_VALUE`（remember_web cookie 值），或账密登录 `ACL_EMAIL` + `ACL_PASSWORD`。
2. 续期：进服务器页，点 Renew（含确认弹窗 cap-widget），刷新页面读 `.srv-expiry` 文案验真。
3. 通知：Telegram 推送成功 / 失败。

## Secrets

| 名称 | 必填 | 说明 | 示例 |
|---|---|---|---|
| `COOKIE_VALUE` | ✅*1 | remember_web cookie 值（从浏览器取，一年有效期） | `eyJpdiI6...` |
| `ACL_EMAIL` | ✅*1 | 账号邮箱（COOKIE_VALUE 失效时降级登录用） | `you@outlook.com` |
| `ACL_PASSWORD` | ✅*1 | 账号密码 | `***` |
| `SERVER_PAGE_URL` | ✅ | 服务器页完整 URL，多个换行/逗号分隔 | `https://aclclouds.com/server/YOUR_SERVER_ID` |
| `SERVER_ID` | ❌ | 仅服务器 ID，自动拼接 | `YOUR_SERVER_ID` |
| `TG_BOT_TOKEN` | ❌ | Telegram Bot Token | `123456:AAA-xxx` |
| `TG_CHAT_ID` | ❌ | 接收通知 Chat ID | `123456789` |
| `NODE_LINK` | ❌ | 代理节点（vless/hy2/vmess/trojan/tuic/anytls/socks5），配了则 workflow 起 sing-box，不通自动直连 | `vless://...` |

> *1：`COOKIE_VALUE` 与 `ACL_EMAIL+ACL_PASSWORD` 二选一，优先 `COOKIE_VALUE`。

### 如何取 COOKIE_VALUE

1. 登录 aclclouds.com，按 F12 → Application → Cookies
2. 找 `remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d`，复制其 value
3. 粘贴为 GitHub Secret 值

COOKIE_VALUE 失效信号：日志出现 `COOKIE_VALUE 已失效，降级为账密登录`，需重新录制更新 Secret。

## 部署

 1. 新建 GitHub 仓库，把本目录文件推上去。
 2. Settings → Secrets and variables → Actions 配好上表 Secrets。
 3. Actions 启用工作流，手动跑一次看日志。首次为 24h 巡检（`renew.yml` cron `10 10 * * *`）。每次运行自动更新 `time.txt`，防止 6 个月无活动导致 GitHub 暂停 Actions。

## 本地调试

```bash
npm install
node --check renew.js
set COOKIE_VALUE=eyJpdiI6...
set SERVER_PAGE_URL=https://aclclouds.com/server/YOUR_SERVER_ID
set DRY_RUN=true
set HEADLESS=false
npm start
```

## 已知缺口

- 真实续期按钮选择器待 `can_renew=true` 时补录确认，当前文案泛匹配；若出现 `NO_BUTTON`，贴运行截图+补录制给我。
- 账密登录（`ACL_EMAIL` + `ACL_PASSWORD`）结构已由 AgentScribe 751a24bb 抓包确认：`#username` + `#password` + `cap-widget` + `button.auth-submit-btn`，可直接使用；仍建议优先用 `COOKIE_VALUE`（免 cap 验证，更快）。
