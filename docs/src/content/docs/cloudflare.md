---
title: Cloudflare CDN 与 WAF（CF 盾）
description: 把 DiTing 放到 Cloudflare 橙云代理后面：证书、真实 IP 还原、WAF 豁免与受控端迁移的完整步骤
---

# Cloudflare CDN 与 WAF（CF 盾）

本指南把 DiTing 放到 **Cloudflare 橙云代理（CDN/WAF，俗称「CF 盾」）**后面：浏览器与受控端都访问 CF 边缘，由 CF 回源到你的服务器。收益是隐藏源站 IP、托管 WAF/DDoS 兜底、免费 TLS 边缘证书。

与 [隐藏源站 IP（Tunnel）](../tunnel-guide/) 的区别：

| 维度 | 本指南（橙云代理） | Tunnel 指南（cloudflared） |
|------|-------------------|---------------------------|
| 入站端口 | 需开 80/443（建议防火墙只放行 CF IP 段） | 零入站 |
| 源站 IP | DNS 灰云记录/历史解析仍可能泄露 | 完全隐藏 |
| 配置复杂度 | 低（DNS + 证书 + 反代增量） | 中（多一个常驻隧道进程） |
| 适合 | 已有面板反代、想快速上 WAF | 不想开任何入站端口 |

两条路线可组合（Tunnel 回源 + 橙云入口）。**无论哪条，都不替代认证**：admin token/密码强度、2FA、IP 白名单仍是你自己兜底。

> 本指南全部步骤经过真机验证（1Panel + Docker 形态，Debian 13）。受控端上报是普通 HTTPS POST，是各类探针中对 CF 最友好的传输——**不需要任何代码改动**，工作量全在部署配置。

---

## 1. 前置条件

- 域名已托管到 Cloudflare（NS 接入，zone 状态 Active）
- 服务端已按 [反向代理与 HTTPS](../reverse-proxy/) 部署：8081 绑回环，面板/Nginx 反代 443
- 一个子域，如 `monitor.example.com`

## 2. Cloudflare 控制台配置

### 2.1 DNS

添加 A 记录 `monitor` → 源站公网 IP，**开启橙云（Proxied）**。

可选：另加一条**灰云**记录 `monitor-direct` 作应急直连/回滚通道（注意这会暴露源站 IP，权衡后决定）。

### 2.2 SSL/TLS 模式与源站证书

SSL/TLS 概述设为 **完全（严格）/ Full (strict)**：CF 回源校验证书可信且主机名匹配。各模式对比：

| 模式 | 回源校验 | 评价 |
|------|---------|------|
| 灵活 Flexible | 不校验，HTTP 回源 | ❌ 回源明文，Token 可被嗅探 |
| 完全 Full | 不校验证书内容 | 自签也能过，但无中间人防护 |
| 完全（严格）Full (strict) | 校验可信 + 主机名 | ✅ 推荐 |

Full (strict) 下源站证书二选一：

- **CF Origin CA 证书（推荐）**：控制台 → SSL/TLS → 源服务器 → 创建证书。主机名填 `monitor.example.com`，私钥类型 RSA，有效期默认 15 年。**只有 CF 信任它**，浏览器直连源站会报不受信任——这正是我们要的（源站只服务 CF）。创建后把「源证书」与「私钥」保存到源站（私钥仅显示一次）。
- **Let's Encrypt 等公共证书**：已有则直接复用，无需改动。

⚠️ 自签证书（如 `--bundled-proxy` 生成的）过不了 Full (strict)，会报 **525/526**。

### 2.3 安全姿态（让受控端过盾的关键）

受控端是非浏览器客户端，**过不了 JS 质询**。参考各探针项目的通行做法，不在代码里绕盾，而是配置豁免：

1. **WAF 自定义规则**（安全性 → WAF → 自定义规则）：
   - 表达式：
     ```
     (http.request.uri.path eq "/api/report") or (starts_with(http.request.uri.path, "/api/releases/agent/"))
     ```
   - 动作：**Skip（跳过）**，勾选跳过其余自定义规则与托管规则
   - 这两条是受控端仅有的访问路径：上报与签名二进制下载
2. **Bot Fight Mode：关闭**（安全性 → Bots）。它是全局开关，无法按路径豁免，开着会拦 Go HTTP 客户端
3. **Browser Integrity Check：关闭**（安全性 → 设置）。该校验 UA/头部特征，Go 默认 UA 可能被拦
4. **安全级别保持「中」**，不要全局开「我正在遭受攻击」（Under Attack）模式。确需开启时，用 Configuration Rule 对上述两条路径单独设安全级别「基本关闭」

> 浏览器访问（面板/公开页/主题）不受上述豁免影响，正常享受 WAF 防护。

### 2.4 无需操作的部分

- **WebSocket**：CF 默认支持，主题实时通道直接可用
- **gRPC**：DiTing 不用，无需开启
- **SSE/长连接**：CF 代理空闲超时约 100s（超时回 524）。DiTing 的 SSE 每 5s 推一帧、WS 有周期广播，不会触发；AI 生成等长任务已是异步 202，不受影响

## 3. 源站配置

### 3.1 真实 IP 还原（最关键，先做）

CF 代理后 TCP 对端是 CF 边缘 IP。不还原的后果：**全站限流共享一个 IP 桶**（所有受控端+管理员互相挤占配额）、登录暴破防护把所有管理员一起封、IP 白名单与审计日志全部记成 CF IP。

在反代的 **http 上下文**加（IP 段以 CF 官方页为准，部署时拉最新：`https://www.cloudflare.com/ips-v4` 与 `ips-v6`）：

```nginx
# /etc/nginx/conf.d/cf-realip.conf（或面板的 http 级配置入口）
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
# ……完整清单约 20 条，两个官方页全部列入
real_ip_header CF-Connecting-IP;
real_ip_recursive on;
```

要点：

- `set_real_ip_from` 限定只信任 CF 段来源的 `CF-Connecting-IP`，直连伪造无效
- realip 在限流之前执行，还原后 `$binary_remote_addr`/`$remote_addr` 即真实客户端 IP，现有限流规则无需改动
- 需要 `http_realip_module`（nginx 官方包与 OpenResty 默认带；`nginx -V` 可查）

### 3.2 WebSocket 升级头（面板用户重点）

CF 边缘转发 WS 握手时 `Connection` 头是 `keep-alive`。**透传 `$http_connection` 的模板（1Panel 默认如此）过 CF 后 WS 必断**，症状是主题页实时数值变 `N/A`。必须用 map：

```nginx
# http 上下文
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
# location 内
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
```

### 3.3 站点配置

在 [反向代理与 HTTPS](../reverse-proxy/) 的通用配置基础上，确认证书换成 §2.2 的 Origin CA/LE 证书即可，其余（WS/SSE location、`/api/report` 16k body 限制、长超时）不变。

**1Panel + Docker 形态的落盘位置**（真机验证）：

- 站点配置放 `/opt/1panel/www/conf.d/<站点>.conf`（持久化挂载进 OpenResty 容器，http 级 include；§3.1/§3.2 的 http 级指令也可单独放一个 `.conf` 在同目录）
- 证书放 `/opt/1panel/www/sites/<站点>/ssl/`，容器内路径为 `/www/sites/<站点>/ssl/`，私钥权限 600
- 1Panel 默认站点带 `ssl_reject_handshake on`：**新域名没建站点前，CF 回源一律 525**——这不是 CF 故障
- 改完 `docker exec <openresty容器> nginx -t && docker exec <openresty容器> nginx -s reload`
- 注意：手工 conf 不在 1Panel 站点管理界面内，面板大版本升级后建议复查

### 3.4 TRUST_PROXY 拓扑表

真实 IP 由反代还原后经 `X-Real-IP`/`X-Forwarded-For` 传给服务端，因此 **TRUST_PROXY 只填「反代自己的来源地址」，不要填 CF 段**（CF 边缘会附加客户端可伪造的 XFF 前缀，直接信任 CF 段反而引入绕过面）：

| 拓扑 | TRUST_PROXY |
|------|-------------|
| 反代与服务端同机（宿主进程，推荐形态） | 默认 `loopback`，不用改 |
| 服务端在 Docker、反代在宿主/另一容器（经发布端口进容器） | 容器所见反代来源网段，如 `172.20.0.0/16`（`docker network inspect` 查 Subnet） |
| 反代在另一台主机 | 该主机 IP/CIDR |

⚠️ Docker 形态默认 `loopback` 匹配不到 bridge 网段，症状是审计日志全记网关 IP（如 `::ffff:172.20.0.1`）、限流全站一桶——**套 CF 前先修这个**，否则失真叠加。

### 3.5 源站防火墙（防绕过 CF 直打）

橙云只保护「走域名」的流量；源站 IP 若泄露，攻击者可直连绕过 WAF。建议 80/443 仅放行 CF IP 段（与 §3.1 同一清单）+ 你的管理网段；**SSH 端口与 8081 不受影响**（8081 本就只绑回环）。Tunnel 路线天然满足此条。

## 4. 受控端迁移

受控端用系统证书池校验 TLS，CF 边缘是公共信任证书，**无需安装任何自定义 CA**，只改上报地址：

```bash
# Linux（systemd 安装形态；env 路径以 systemctl cat diting-agent 的 EnvironmentFile 为准）
sudo cp -p /etc/diting/agent.env /etc/diting/agent.env.bak
sudo sed -i 's|^SERVER_URL=.*|SERVER_URL=https://monitor.example.com|' /etc/diting/agent.env
sudo systemctl restart diting-agent
```

- 改完观察一个上报周期（默认 20s）：面板节点在线、`last_seen` 新鲜
- 服务端「设置 → Agent 连接地址」（或环境变量 `PUBLIC_URL`）同步改为 CF 域名，新装命令才会生成新地址
- 局域网受控端可保留直连内网地址（split-horizon），不依赖 CF；公网受控端走 CF 域名

## 5. 验收清单

正向（全部实测通过再收工）：

- [ ] `curl -sI https://monitor.example.com/api/version` → 200，响应头含 `server: cloudflare` 与 `cf-ray`
- [ ] 受控端 `POST /api/report` 经 CF 返回 200（站点访问日志可见，UA 为 `diting-agent-go/<版本>`）
- [ ] **真实 IP**：访问日志 `$remote_addr` 与审计日志记真实客户端 IP，而非 CF 边缘/网关 IP
- [ ] WS 升级经 CF 返回 101；SSE 持续推帧 ≥5 分钟不断流
- [ ] 浏览器登录后台：Cookie 带 Secure、写操作正常、审计记真实 IP
- [ ] 长查询（720h 窗口）无 524
- [ ] 外网直连源站 IP:443 不通（防火墙生效判据）

负向对照（证明豁免确实在起作用，**验完立即恢复**）：

- [ ] 临时删除 WAF Skip 规则并开 Under Attack → 受控端上报被质询页拦截（403/503 HTML）
- [ ] 恢复 Skip 规则与安全级别 → 上报恢复 200

## 6. 故障排查

| 症状 | 原因 | 处理 |
|------|------|------|
| 525 | CF↔源站 TLS 握手失败：源站没这个域名的站点/证书，或 SNI 被拒 | 建站点 + 装证书（1Panel 默认 `ssl_reject_handshake`） |
| 526 | Full (strict) 下源站证书不受信/主机名不匹配 | 换 Origin CA 或公共证书；自签不行 |
| 上报返回 403/503 且 body 是 HTML 质询页 | 安全级别/BIC/Bot Fight/WAF 拦了非浏览器客户端 | 按 §2.3 配豁免 |
| 主题实时 N/A、WS 连不上 | 升级头透传了 `$http_connection` | 按 §3.2 用 map |
| 审计/限流全是同一个 IP | realip 未配或 TRUST_PROXY 拓扑错 | 按 §3.1/§3.4 核对 |
| 524 | 同步请求超过 CF 100s 超时 | 长任务走异步（DiTing 已内置）；检查反代超时 |
| 浏览器正常、受控端全离线 | 受控端 SERVER_URL 还是旧地址或旧证书链 | 按 §4 迁移 |

## 7. 回滚

- DNS 橙云切灰云（或切应急直连记录）→ 流量直连源站，CF 退出链路
- 受控端 `SERVER_URL` 改回直连地址（恢复备份的 env 即可）
- 源站 realip 段对非 CF 来源不生效，直连流量行为不变，无需回滚

## 8. 明确不做的事

- 不在受控端代码里加 CF 专用 header/UA/指纹伪装——各参考探针项目均无此做法，豁免靠部署配置
- 不为过盾关闭全站认证或公开管理接口

## 9. 可选兜底方案

主路线（橙云 + 豁免）走不通或不想折腾时，两个兜底：

### 9.1 兜底一：灰云专属上报域名（受控端完全绕开 CF）

给受控端单独建一个**灰云（DNS only，不代理）**子域，如 `agent.example.com`，A 记录直指源站 IP。受控端直连源站上报，不经过 CF 边缘——**不需要任何 WAF 豁免、不受 Bot Fight Mode / Under Attack 影响**；浏览器管理端仍走橙云主域名享受防护。

步骤：

1. CF DNS 添加 A 记录 `agent` → 源站 IP，**代理状态关闭（灰云）**
2. 为该域名申请**公共信任证书**（Let's Encrypt 即可）：灰云是直连，**Origin CA 证书在这里不可用**（只有 CF 信任它）。1Panel 用户走面板「网站 → 证书」申请；命令行可用 `certbot --nginx -d agent.example.com`（灰云直连，HTTP-01 校验可通过）
3. 源站反代增加该域名的站点（或与主站点共用配置、`server_name` 并列两个域名），装好第 2 步的证书
4. 受控端 `SERVER_URL` 改 `https://agent.example.com`（按 §4 的命令）；服务端「Agent 连接地址」/`PUBLIC_URL` 同步改，新装命令才生成灰云地址
5. 防火墙注意：§3.5 若已把 80/443 收敛为「仅 CF 段」，灰云直连会被挡——需为受控端出口放行，或接受该兜底与防火墙收敛二选一

权衡（决定前必读）：

- **灰云记录公开暴露源站 IP**：攻击者拿到 IP 后可直连绕过橙云 WAF，主域名的防护收益打折。适合「受控端稳定压倒一切、源站另有防火墙/认证兜底」的场景
- realip / `TRUST_PROXY` 无需改动：直连请求不带 `CF-Connecting-IP`，realip 只对 CF 段来源生效，受控端真实 IP 天然保留
- 回滚：受控端 `SERVER_URL` 改回橙云域名即可，灰云记录可留作应急通道

### 9.2 兜底二：把 CF API Token 交给 AI 工具自动配置

不想手动点控制台：创建一个权限受限的 API Token，连同下面的提示词交给有 shell 能力的 AI 工具（Claude Code、Qoder 等），由它调 API 完成 CF 侧全部配置；若再给它源站/受控端的 SSH 访问，可一路配到验收。

**先创建 Token**（CF 控制台 → My Profile → API Tokens → Create Token → Custom token），权限按下表勾选，Zone Resources 限定到目标 zone：

| Permission | 用途 |
|------------|------|
| Zone / Zone / Read | 查 zone id、读当前配置 |
| Zone / DNS / Edit | 建橙云 A 记录 |
| Zone / Zone Settings / Edit | SSL 模式、安全级别、BIC、Bot Fight Mode |
| Zone / SSL and Certificates / Edit | API 签发 Origin CA 证书 |
| Zone / Firewall Services / Edit | WAF Skip 规则（Rulesets API） |

⚠️ Token 等同所授权限的钥匙：只交给可信工具、不落代码库，**用完后回控制台撤销**（Roll）。缺权限时 API 会报 1016/10405 等错误码，提示词已要求 AI 停下来报告而不是硬试。

**全套提示词**（复制整段，替换开头 5 个变量后交给 AI 工具）：

````text
任务：把 DiTing 监控服务端部署到 Cloudflare 橙云代理（CDN/WAF）后面，完成 CF 侧全部配置；如提供 SSH 则继续完成源站与受控端配置。全程用 Cloudflare API（https://api.cloudflare.com/client/v4），认证头 Authorization: Bearer <API_TOKEN>。

== 输入变量（开始前先确认已填）==
API_TOKEN = 【填 CF API Token】
DOMAIN    = 【填接入域名，如 monitor.example.com】
ORIGIN_IP = 【填源站公网 IP】
ORIGIN_SSH = 【选填：源站 SSH，如 ssh user@1.2.3.4 -p 22；留空则跳过阶段二】
AGENT_SSH  = 【选填：受控端 SSH 列表，逗号分隔；留空则跳过阶段三】

== 执行纪律（全程有效）==
- 先读后写：任何修改前先 GET 现状；已符合目标的项跳过并记录，不重复创建
- 只动与本任务相关的记录/规则/设置；不删除任何既有 DNS 记录、WAF 规则或其它 zone 配置
- 不启用 Under Attack 模式；安全级别只允许设为 medium，不允许更低
- Token 只放环境变量或请求头，不写入任何持久化文件，不回显到输出/日志
- 私钥文件权限 600；私钥内容不出现在报告与对话输出中
- API 返回 success=false 时读取 errors[].code/message：权限类错误（如 1016、10405、9109）立即停止该项并报告缺哪个权限，不盲目重试；每个写操作最多重试 1 次
- 每完成一步输出：做了什么、API 返回关键结果；最后输出总报告

== 阶段一：CF 侧配置（必做）==
1. 验证 Token：GET /user/tokens/verify，确认 status=active
2. 取 zone id：GET /zones?name=<DOMAIN 的根域>，取 result[0].id；查不到则停止并报告「域名未托管到本账号」
3. DNS：GET /zones/<zone_id>/dns_records?name=<DOMAIN>
   - 无记录：POST /zones/<zone_id>/dns_records，body {"type":"A","name":"<DOMAIN>","content":"<ORIGIN_IP>","proxied":true,"ttl":1}
   - 已有记录：核对 content 与 proxied=true；不一致时报告差异并等待确认，不直接覆盖
4. SSL 模式：PATCH /zones/<zone_id>/settings/ssl，body {"value":"strict"}（Full strict）
5. 签发 Origin CA 证书（本机需有 openssl）：
   a. openssl req -new -newkey rsa:2048 -nodes -keyout origin.key -out origin.csr -subj "/CN=<DOMAIN>" -addext "subjectAltName=DNS:<DOMAIN>"
   b. POST /certificates，body {"csr":"<origin.csr 内容，换行转义为 \n>","hostnames":["<DOMAIN>"],"request_type":"origin-rsa","requested_validity":5475}
   c. 取 result.certificate 存为 origin.crt；下载 CF Origin CA 根证书 https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem，拼接 fullchain.pem = origin.crt + 根证书
   d. origin.key / fullchain.pem 存入本地工作目录（如 ./cf-origin/），私钥 chmod 600；记录证书 id 与到期时间
6. WAF 豁免规则：
   a. GET /zones/<zone_id>/rulesets/phases/http_request_firewall_custom/entrypoint 取规则集 id；404 则 POST /zones/<zone_id>/rulesets 创建，body {"name":"default","kind":"zone","phase":"http_request_firewall_custom","rules":[<下方规则>]}
   b. 已有规则集：先列出规则，若已存在同表达式豁免规则则跳过；否则 POST /zones/<zone_id>/rulesets/<ruleset_id>/rules，body：
      {"description":"diting-agent-bypass","action":"skip","action_parameters":{"ruleset":"current","phases":["http_request_firewall_managed","http_ratelimit"],"products":["bic","securityLevel"]},"expression":"(http.request.uri.path eq \"/api/report\") or (starts_with(http.request.uri.path, \"/api/releases/agent/\"))"}
   c. 注意：免费版 Bot Fight Mode 无法用 Skip 豁免，只能全局关（下一步）
7. PATCH /zones/<zone_id>/settings/browser_check，body {"value":"off"}
8. PATCH /zones/<zone_id>/settings/security_level，body {"value":"medium"}
9. 关闭 Bot Fight Mode：PATCH /zones/<zone_id>/settings/bot_fight_mode，body {"value":"off"}；若该键不存在（404），GET /zones/<zone_id>/settings 找 bot 相关键名再试；仍失败则在报告中标注「需人工到控制台 Security → Bots 关闭」
10. 回读核验：GET dns_records / settings/ssl / settings/security_level / settings/browser_check 与规则集，逐项确认与目标一致
11. 链路探测：curl -sI https://<DOMAIN>/api/version
    - 预期 525（源站尚未部署证书，属正常中间态，说明 CF 链路已通）
    - 若 200 且响应头含 cf-ray：源站已有可用证书，记录之
    - 其它状态码按响应头/server 字段诊断并报告
12. 输出阶段一报告：全部改动清单（含规则 id、证书 id）、核验结果、待人工项

== 阶段二：源站配置（仅当 ORIGIN_SSH 非空）==
1. SSH 登录源站，探测反代形态：原生 nginx / 1Panel Docker（OpenResty 容器）/ 其它面板，按实际形态适配，不套用不存在的路径
2. 部署证书：把本地 origin.key 与 fullchain.pem 传到源站反代约定路径（1Panel Docker 形态：宿主 /opt/1panel/www/sites/<站点>/ssl/，容器内 /www/sites/<站点>/ssl/；原生 nginx 自定），私钥 600
3. 反代增量配置（改前备份原文件）：
   a. http 级 realip：从 https://www.cloudflare.com/ips-v4 与 https://www.cloudflare.com/ips-v6 拉最新全部 IP 段，逐条 set_real_ip_from；real_ip_header CF-Connecting-IP; real_ip_recursive on;
   b. http 级 map $http_upgrade $connection_upgrade { default upgrade; '' close; }；WS/SSE location 用 proxy_set_header Connection $connection_upgrade（禁止透传 $http_connection，否则过 CF 后 WS 必断）
   c. 站点：listen 443 ssl，server_name <DOMAIN>，证书指向第 2 步文件；反代到服务端（DiTing 默认 127.0.0.1:8081）；location = /api/report 限 client_max_body_size 16k；WS/SSE 路径 proxy_read_timeout 3600s + proxy_buffering off；其余 location proxy_read_timeout 200s；所有 location 传 Host / X-Real-IP / X-Forwarded-For / X-Forwarded-Proto
   d. 1Panel 注意：默认站点 ssl_reject_handshake on，新域名必须先建站点否则一律 525；手工 conf 放 /opt/1panel/www/conf.d/（http 级 include）
4. TRUST_PROXY：服务端在 Docker、反代经发布端口进容器时，设容器所见反代来源网段（docker network inspect 查 Subnet，如 172.20.0.0/16）；同机宿主进程反代保持默认 loopback。禁止把 CF IP 段填进 TRUST_PROXY。改 .env/compose 后重建容器生效
5. nginx -t 通过后再 reload（Docker 形态：docker exec <openresty容器> nginx -t && docker exec <openresty容器> nginx -s reload）
6. 复验：curl -sI https://<DOMAIN>/api/version 应 200 且含 cf-ray；失败按 525=站点/证书缺失、526=证书不受信/主机名不匹配 诊断

== 阶段三：受控端迁移（仅当 AGENT_SSH 非空）==
逐台执行（Linux systemd 安装形态）：
1. systemctl cat diting-agent 确认 EnvironmentFile 路径（默认 /etc/diting/agent.env）
2. sudo cp -p <env文件> <env文件>.bak-cf
3. sudo sed -i 's|^SERVER_URL=.*|SERVER_URL=https://<DOMAIN>|' <env文件>
4. sudo systemctl restart diting-agent
5. 等一个上报周期（默认 20s），确认服务 active；全部完成后经服务端公开接口或面板确认节点在线
说明：受控端用系统证书池，CF 边缘是公共信任证书，无需安装任何 CA。

== 总报告格式 ==
- 已完成：逐项（CF 侧 / 源站 / 受控端）
- 待人工：缺权限项、Bot Fight Mode 控制台开关等
- 验证证据：curl 状态码与 cf-ray、节点在线数
- 回滚方法：DNS 橙云切灰云、受控端恢复 .bak-cf、删除本次新增规则/证书 id
````

提示词覆盖不到的（AI 无 SSH 时）：源站反代与 `TRUST_PROXY`（§3）、受控端迁移（§4）——按对应章节手工完成，或把 SSH 访问补进变量再跑一轮。