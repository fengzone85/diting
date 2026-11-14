---
title: 反向代理与 HTTPS
description: 通过 Nginx / 宝塔 / 1Panel 绑定域名反代；必须透传 WebSocket 升级头
---

# 反向代理与 HTTPS

DiTing 服务端默认只监听 `127.0.0.1:8081`（端口由 `.env` 的 `PORT` 决定），**不内置 HTTPS 反代，也不占用 443**。

绝大多数部署走 **A 路径**：在宝塔 / 1Panel / 已有 Nginx 中绑定域名、由面板申请证书，再反代到该回环端口。只有无面板、无域名的局域网场景才需要文末的 **B 路径**（`--bundled-proxy` 自带自签证书）。

> ⚠️ `/api/clients`、`/api/rpc2` 是实时数据通道（WebSocket），`/api/clients/sse` 是 SSE。反代若漏透传升级头，浏览器 WSS 握手失败，主题页显示「离线」、实时数值变 `N/A`，而服务端直连完全正常——很容易误判成后端故障。

> 打算把域名放到 Cloudflare 橙云代理（CF 盾）后面？证书、真实 IP 还原、WAF 豁免与受控端迁移的完整步骤见 [Cloudflare CDN 与 WAF](../cloudflare/)。

## 通用 Nginx / OpenResty 配置

下面是可直接粘贴的完整配置。把 `monitor.example.com`、证书路径、`8081` 换成实际值（端口跟随 `.env` 的 `PORT`）。

```nginx
# map 与 limit_req_zone 必须在 http {} 上下文。
# 面板的站点配置通常被 include 进 http，放在文件顶层即可。
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name monitor.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # 实时端点：WebSocket / SSE / JSON-RPC。Upgrade 与 Connection 两行缺一不可。
    location ~ ^/api/(clients(/sse)?|rpc2)$ {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        # 管理端鉴权依赖此头：缺少会被当成明文 HTTP 而拒绝管理操作。
        proxy_set_header X-Forwarded-Proto https;
        client_max_body_size 16k;
        proxy_read_timeout 200s;
        proxy_send_timeout 200s;
    }
}
```

要点：

- `map` 用 `'' → close`，普通 HTTP 请求可正常复用连接；不要硬编码 `Connection "Upgrade"`。
- 正则 `location` 优先于前缀 `location /`，但建议按上面顺序放置便于阅读。
- `proxy_buffering off` 是 SSE 实时下发的必要条件；`3600s` 避免 WS/SSE 被默认 60s 超时切断。
- **`TRUST_PROXY`**：面板与服务端同机（最常见）保持默认 `loopback` 即可；若反代在**另一台主机或另一个容器**，必须显式设置 `TRUST_PROXY=<反代 IP/CIDR 或跳数>`，否则 `req.ip` 会算到反代头上，IP 白名单与限流全部失效。
- 完整示例（含 `limit_req` 限流、gzip、上报端点独立限流）见仓库 `nginx/monitor.conf.example`。

## 宝塔面板

1. 「网站」添加站点、绑定域名，在 SSL 里申请证书并开启强制 HTTPS。
2. 站点设置 →「反向代理」→ 添加反向代理，目标 URL 填 `http://127.0.0.1:8081`。
3. 打开该反代的「配置文件」（原文），把上面**实时端点 `location`** 整段粘到 `location /` 之前，并在文件顶层补 `map $http_upgrade`。
4. 新版宝塔的反向代理有「支持 WebSocket」开关——打开它等价于自动加 `Upgrade`/`Connection`，但仍建议按原文确认 `proxy_http_version 1.1` 与 `proxy_buffering off` 是否齐备。
5. 保存并重载 Nginx，用下方自检命令验证。

> 宝塔模板常自带 `add_header Cache-Control no-cache;`，会让静态资源缓存失效；不需要时可删。

## 1Panel（OpenResty）

1. 「网站」→ 创建网站 → 反向代理，填域名与 `127.0.0.1:8081`。
2. 「网站」→ 证书，用 ACME 申请证书（只开放 443 的机器用 DNS-01）。
3. 站点 → 反向代理 →「原文」，粘贴上面的实时端点 `location` 与顶层 `map`；删除模板自带的 `add_header Cache-Control no-cache;`。
4. **1Panel 的 OpenResty 模板会给每个代理请求无条件附加 `Connection: upgrade`**。这不影响 DiTing（Node 的 `upgrade` 事件只在真实升级时触发），但不要因为看到这个头就以为 WebSocket 已配好——仍需确认 `Upgrade` 头与 `proxy_http_version 1.1`。
5. 若站点套了 Cloudflare，需在 CF 的「网络」设置里开启 WebSockets。

## 自检与故障排查

```bash
# 应返回 101；返回 404/200 说明升级头没有透传到后端
curl -sk -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
  https://你的域名/api/clients
```

| 现象 | 原因 |
|---|---|
| 主题页「离线」、实时数值 `N/A`、控制台 `WebSocket error` | WSS 握手失败：缺 `Upgrade`/`Connection` 或 `proxy_http_version 1.1` |
| 管理操作被拒 / 一直要求 HTTPS | 缺 `proxy_set_header X-Forwarded-Proto https` |
| 配了 IP 白名单后所有请求 403 | 反代不同机却未设 `TRUST_PROXY` |
| SSE 事件延迟或成批到达 | `proxy_buffering off` 未生效 |
| WS 每分钟断一次 | `proxy_read_timeout` 仍是默认 60s |

## B 路径：无域名 / 局域网（可选）

仅在**没有面板、没有域名**的纯净机器上使用：

```bash
sudo bash diting.sh --bundled-proxy
```

- 动态签发自签 CA 与服务端证书（SAN 含 `localhost`、`127.0.0.1`、本机 IP），生成在 `server/certs/`，已存在则不覆盖。
- 启动 compose 的 `bundled-proxy` profile（nginx 容器，`network_mode: host`，只监听 443），因此 `TRUST_PROXY` 保持默认 `loopback` 不变。
- 完成后输出 `https://<IP>/install`；浏览器会有**一次**自签证书警告，属预期。
- **跨机受控端**必须信任该 CA：把 `server/certs/ca.crt` 加入系统信任库，或设 `SSL_CERT_FILE` 指向它；Go 受控端默认校验系统根 CA，不会接受自签证书。本机受控端可直接使用 `http://localhost:8081`。
- B 会占用宿主机 443，**A 路径用户不要执行**；已有面板反代时请只用上面的 A 路径配置。
