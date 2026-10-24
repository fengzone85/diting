# Diting 修复补丁（可直接粘贴应用）

基线：https://github.com/fengzone85/diting HEAD `48ee69c`
本文件是 `diting-bugfix.diff` 的 Markdown 外壳——如果 `.patch`/`.diff` 无法预览或下载，直接复制下面代码块里的全部内容，存成 `diting-bugfix.diff` 即可。

## 改动概览

| 文件 | 新增行 | 删除行 |
| --- | --- | --- |
| `agent-go/collector/diskio.go` | +7 | -0 |
| `agent-go/collector/diskio_test.go` | +52 | -0 |
| `agent-go/collector/linux.go` | +9 | -3 |
| `server/src/alerts.js` | +20 | -3 |
| `server/src/api.js` | +27 | -20 |
| `server/src/auth.js` | +9 | -5 |
| `server/src/compat.js` | +1 | -12 |
| `server/src/online.js` | +36 | -0 |
| `server/src/v1.js` | +1 | -3 |
| `server/web/src/utils/i18n/coverage.test.ts` | +6 | -0 |

## 应用方式

```bash
cd /path/to/diting            # 干净检出 48ee69c
git apply --check diting-bugfix.diff   # 先检查能否干净应用
git apply diting-bugfix.diff
cd server && npm test          # 464 pass
cd web && npx vitest run       # 103 pass
cd ../../agent-go && go test ./...
```

不想落文件的话，也可以把复制到的内容通过 stdin 交给 git：`git apply -`，然后粘贴、回车、Ctrl-D。

## 完整补丁

```diff
diff --git a/agent-go/collector/diskio.go b/agent-go/collector/diskio.go
index e2a5577..0c8fc6d 100644
--- a/agent-go/collector/diskio.go
+++ b/agent-go/collector/diskio.go
@@ -42,6 +42,13 @@ func diskIO() (readBytes, writeBytes uint64) {
 		if strings.HasPrefix(dev, "dm-") || strings.HasPrefix(dev, "md") {
 			continue
 		}
+		// 只统计整盘，跳过分区。此前把 vda 与 vda1/vda2 一起累加，
+		// 同一份 IO 被重复计算（实测本机写扇区虚增 1.83 倍）。
+		// 用 sysfs 的 partition 文件判断而非「名字以数字结尾」——
+		// nvme0n1 这类整盘名字也以数字结尾，按名字判断会误杀。
+		if _, err := os.Stat("/sys/class/block/" + dev + "/partition"); err == nil {
+			continue
+		}
 		rSect, err := strconv.ParseUint(fields[5], 10, 64)
 		if err != nil {
 			continue
diff --git a/agent-go/collector/diskio_test.go b/agent-go/collector/diskio_test.go
new file mode 100644
index 0000000..ce37081
--- /dev/null
+++ b/agent-go/collector/diskio_test.go
@@ -0,0 +1,52 @@
+//go:build linux
+
+package collector
+
+import (
+	"bufio"
+	"os"
+	"strconv"
+	"strings"
+	"testing"
+)
+
+// 回归：diskIO 只应统计整盘，不得重复累加分区。
+func TestDiskIOPartitionDoubleCount(t *testing.T) {
+	readAll, writeAll := diskIO()
+
+	f, err := os.Open("/proc/diskstats")
+	if err != nil {
+		t.Skip(err)
+	}
+	defer f.Close()
+	var wholeR, wholeW uint64
+	var hasPartition bool
+	sc := bufio.NewScanner(f)
+	for sc.Scan() {
+		fs := strings.Fields(sc.Text())
+		if len(fs) < 14 {
+			continue
+		}
+		dev := fs[2]
+		if strings.HasPrefix(dev, "ram") || strings.HasPrefix(dev, "loop") || strings.HasPrefix(dev, "zram") ||
+			strings.HasPrefix(dev, "dm-") || strings.HasPrefix(dev, "md") {
+			continue
+		}
+		r, _ := strconv.ParseUint(fs[5], 10, 64)
+		w, _ := strconv.ParseUint(fs[9], 10, 64)
+		if _, err := os.Stat("/sys/class/block/" + dev + "/partition"); err == nil {
+			hasPartition = true
+			t.Logf("分区 %s 已跳过: r=%d w=%d", dev, r*512, w*512)
+			continue
+		}
+		wholeR += r * 512
+		wholeW += w * 512
+	}
+	if !hasPartition {
+		t.Skip("当前主机没有分区，无法验证重复计数")
+	}
+	if readAll != wholeR || writeAll != wholeW {
+		t.Fatalf("diskIO 统计含分区重复：got r=%d w=%d, want r=%d w=%d", readAll, writeAll, wholeR, wholeW)
+	}
+	t.Logf("整盘合计 r=%d w=%d，与 diskIO 输出一致（分区已剔除）", wholeR, wholeW)
+}
diff --git a/agent-go/collector/linux.go b/agent-go/collector/linux.go
index bac8573..e1169a2 100644
--- a/agent-go/collector/linux.go
+++ b/agent-go/collector/linux.go
@@ -99,14 +99,20 @@ func (c *linuxCollector) Collect() (*Metrics, error) {
 	c.prevNet = &netSample{rx, tx}
 	c.prevNetTime = now
 
-	// 磁盘 IO
+	// 磁盘 IO：计数器是累计值，设备重建 / 热插拔 / 虚拟机磁盘重置都会让它回退。
+	// uint64 相减在回退时会下溢成 ~1.8e19，服务端虽钳到 1e15，图表仍会出现
+	// 「1000 TB/s」尖刺。这里与网络分支一致：只有单调递增才计算速率。
 	dr, dw := diskIO()
 	var diskRRate, diskWRate float64
 	if c.prevDiskIO != nil && !c.prevDiskIOTime.IsZero() {
 		dt := now.Sub(c.prevDiskIOTime).Seconds()
 		if dt > 0 {
-			diskRRate = float64(dr-c.prevDiskIO.read) / dt
-			diskWRate = float64(dw-c.prevDiskIO.write) / dt
+			if dr >= c.prevDiskIO.read {
+				diskRRate = float64(dr-c.prevDiskIO.read) / dt
+			}
+			if dw >= c.prevDiskIO.write {
+				diskWRate = float64(dw-c.prevDiskIO.write) / dt
+			}
 		}
 	}
 	c.prevDiskIO = &diskIOSample{dr, dw}
diff --git a/server/src/alerts.js b/server/src/alerts.js
index 1d59b05..2d24210 100644
--- a/server/src/alerts.js
+++ b/server/src/alerts.js
@@ -86,7 +86,12 @@ async function alertThreshold(agent, type, msg, now, cooldown) {
 function checkAgent(a, now, cfg, ctx) {
   try {
     const c = cfg || resolveAgentThresholds(a, ctx);
-    const online = a.last_seen && (now - a.last_seen) < c.offlineSec * 1000;
+    // BUG-2：last_seen=0 表示「从未上报」（刚建节点、agent 还没装完）。
+    // 此前被当作「已离线很久」，创建后第一轮检查就发离线告警，安装完成后
+    // 又因 OFFLINE_SINCE 有记录再补发一条「已上线」，全新节点必然收到一假一真两条噪音。
+    // 语义修正：从未上报不判离线、不记离线起点，等首个心跳后再进入正常判定。
+    if (!a.last_seen) return null;
+    const online = (now - a.last_seen) < c.offlineSec * 1000;
     if (!online) {
       // 记录离线起点（内存态）：供上线通知的宽限期判定。
       if (!OFFLINE_SINCE.has(a.id)) OFFLINE_SINCE.set(a.id, now);
@@ -313,10 +318,22 @@ function checkOfflineThresholdSanity() {
   }
 }
 function start() {
-  // 检查节奏同样按生效的离线阈值推导（阈值收敛后与告警判定同源）
+  // 检查节奏取「全局阈值」与「所有节点/分组覆盖值」中的最小值再折半。
+  // BUG-4：此前只看全局阈值——全局 3600s、单节点覆盖 30s 时，轮询间隔 30min，
+  // 该节点的离线告警最多迟到 30 分钟，覆盖值形同虚设。
   let offlineSec = 60;
   try { offlineSec = db.resolveAlertThresholds().offline_sec; } catch (e) {}
-  const interval = Math.max(10000, (offlineSec * 1000) / 2);
+  let minOverride = Infinity;
+  try {
+    for (const r of db.listAlertOverrides()) {
+      if (r.offline_sec && r.offline_sec < minOverride) minOverride = r.offline_sec;
+    }
+    for (const r of db.listGroupAlertOverrides()) {
+      if (r.offline_sec && r.offline_sec < minOverride) minOverride = r.offline_sec;
+    }
+  } catch (e) { /* 覆盖表读取失败时退回全局节奏 */ }
+  const checkSec = Math.min(offlineSec, minOverride);
+  const interval = Math.max(10000, (checkSec * 1000) / 2);
   // unref：定时器不阻止进程退出（对集成测试进程尤其重要）
   timer = setInterval(check, interval);
   timer.unref();
diff --git a/server/src/api.js b/server/src/api.js
index 21ddbb7..ceb4909 100644
--- a/server/src/api.js
+++ b/server/src/api.js
@@ -8,6 +8,7 @@ const { heavyQuery } = require('./heavy-db');
 const { agentAuth, adminOrReadonly, adminOnly, requireAdmin, safeEqual, setSessionCookie, clearSessionCookie, SESSION_TTL, requireProto, auditLog, revokeAllSessions, verifyTotpOnce, totpGuard, recordTotpFailure, clearTotpFailures, agentScope, inAgentScope, getSession, clearSessionCache } = require('./auth');
 const totp = require('./totp');
 const alerts = require('./alerts');
+const { buildCtx, isOnline } = require('./online');
 const backups = require('./backups');
 const { daysUntil, asyncHandler } = require('./util');
 const { nextExpire, autoRenewExpire } = require('./renew');
@@ -372,16 +373,12 @@ router.get('/agents', adminOrReadonly, agentScope, (req, res) => {
   const now = Date.now();
   // S1/F1：在线判定与告警同源——按「节点 > 分组 > 全局」解析 offlineSec，
   // 避免出现「看板显示在线、告警判离线」的双源分裂（历史审查 C-1/E2 同类问题）。
-  const ctx = {
-    global: db.resolveAlertThresholds(),
-    groupCache: new Map(db.listGroupAlertOverrides().map((r) => [r.grp, r])),
-    nodeCache: new Map(db.listAlertOverrides().map((r) => [r.agent_id, r]))
-  };
+  const ctx = buildCtx();
   // S2/F5：带节点白名单的 API Token 只看到授权范围内的节点。
   const list = db.getAgents().filter((a) => inAgentScope(req, a.id)).map((a) => {
     const latest = db.getLatestMetric(a.id);
     const eff = alerts.resolveAgentThresholds(a, ctx);
-    const online = a.last_seen && (now - a.last_seen) < eff.offlineSec * 1000;
+    const online = isOnline(a, now, ctx);
     const latestOut = latest ? Object.assign({}, latest, { disks: parseDisks(latest.disks) }) : null;
     return Object.assign({}, a, {
       group: a.grp || '',
@@ -571,8 +568,7 @@ router.get('/agents/:id', adminOrReadonly, agentScope, (req, res) => {
   const a = db.getAgent(req.params.id);
   if (!a) return res.status(404).json({ error: 'not found' });
   const latest = db.getLatestMetric(a.id);
-  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
-  const online = a.last_seen && (Date.now() - a.last_seen) < offlineSec * 1000;
+  const online = isOnline(a);
   const latestOut = latest ? Object.assign({}, latest, { disks: parseDisks(latest.disks) }) : null;
   res.json(Object.assign({}, a, { group: a.grp || '', online: !!online, latest: latestOut, hostname: shortHost(a.hostname), ...computeBilling(a) }));
 });
@@ -601,15 +597,15 @@ router.get('/agents/:id/metrics', adminOrReadonly, agentScope, (req, res) => {
 router.get('/overview', adminOrReadonly, agentScope, (req, res) => {
   // S2/F5：全局统计不向节点白名单 Token 开放。
   if (req.agentScope) return res.status(403).json({ error: 'forbidden_scope' });
-  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
   const now = Date.now();
+  const ctx = buildCtx();
   const agents = db.getMonitoredAgents();
   let online = 0, cpuSum = 0, memSum = 0, cnt = 0;
   let trafficUsedBytes = 0; // 本月累计流量（在线节点 latest 的收+发）
   let totalQuotaGB = 0;
   const groups = {}; // 分组 -> { total, online }
   for (const a of agents) {
-    const isOn = a.last_seen && now - a.last_seen < offlineSec * 1000;
+    const isOn = isOnline(a, now, ctx);
     if (isOn) {
       online++;
       const m = db.getLatestMetric(a.id);
@@ -670,14 +666,14 @@ function publicDisabled(res) { return res.status(403).json({ error: 'public view
 router.get('/public/overview', (req, res) => {
   const ui = db.getUiSettings();
   if (ui.public_enabled === false) return publicDisabled(res);
-  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
   const now = Date.now();
+  const ctx = buildCtx();
   const agents = db.getMonitoredAgents();
   let online = 0;
   let cpuSum = 0, memSum = 0, cpuCount = 0, memCount = 0;
   const groups = {};
   for (const a of agents) {
-    const isOn = a.last_seen && now - a.last_seen < offlineSec * 1000;
+    const isOn = isOnline(a, now, ctx);
     if (isOn) {
       online++;
       const m = db.getLatestMetric(a.id);
@@ -707,11 +703,11 @@ router.get('/public/agents', (req, res) => {
   const ui = db.getUiSettings();
   if (ui.public_enabled === false) return publicDisabled(res);
   const showBiz = ui.public_show_business !== false;
-  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
   const now = Date.now();
+  const ctx = buildCtx();
   const list = db.getMonitoredAgents().map((a) => {
     const latest = db.getLatestMetric(a.id);
-    const online = a.last_seen && (now - a.last_seen) < offlineSec * 1000;
+    const online = isOnline(a, now, ctx);
     const m = online && latest ? latest : null;
     const base = {
       id: a.id, name: a.name, group: a.grp || '',
@@ -1520,6 +1516,20 @@ router.get('/settings', adminOrReadonly, (req, res) => {
   if (safe.telegram_bot_token) safe.telegram_bot_token = '';
   res.json({ ui: db.getUiSettings(), notify: safe });
 });
+// BUG-5：PUT /settings 之前是「整体覆盖写」。只提交 { alert: { offline_sec } } 这类
+// 局部设置（脚本、第三方面板、前端漏传字段）会把站点标题、公开开关、背景、通知组等
+// 全部静默重置——线上已复现：改一个离线阈值 → site_title 清空、agent_server_url 丢失，
+// 后端随即 400 server_url_not_configured，创建节点功能瘫痪。
+// 改为深合并：未出现的键保持旧值；显式提交 null 仍可清空（delete 语义由调用方负责）。
+const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
+function mergeUiSettings(base, patch) {
+  const out = Object.assign({}, base);
+  for (const [k, v] of Object.entries(patch)) {
+    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeUiSettings(out[k], v) : v;
+  }
+  return out;
+}
+
 router.put('/settings', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
   const b = req.body || {};
   // 写库前取旧值快照，供审计记录变更字段名（体检 L-4）
@@ -1529,12 +1539,9 @@ router.put('/settings', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
     // M-1：自定义 CSS 在落库前清洗，杜绝 @import/url()/外链字体/脚本注入。
     if (typeof b.ui.custom_css === 'string') b.ui.custom_css = sanitizeCss(b.ui.custom_css);
     sanitizeBackupSettings(b.ui);
-    // setUiSettings 是整体覆盖写：仪表盘布局由专用接口 PUT /admin/dashboard/layout 管理，
-    // 设置表单未携带该字段时沿用旧值，避免在设置页保存后把布局清空。
-    if (!Object.prototype.hasOwnProperty.call(b.ui, 'admin_dashboard_layout')) {
-      b.ui.admin_dashboard_layout = uiBefore.admin_dashboard_layout ?? null;
-    }
-    db.setUiSettings(b.ui);
+    // 部分更新 + 深合并：保留未提交的键（含 admin_dashboard_layout，
+    // 该字段也有专用接口 PUT /admin/dashboard/layout）。
+    db.setUiSettings(mergeUiSettings(uiBefore, b.ui));
   }
   if (b.notify && typeof b.notify === 'object') db.setNotifyConfig(b.notify);
   res.json({ ok: true });
diff --git a/server/src/auth.js b/server/src/auth.js
index af5c6cb..82fdc4d 100644
--- a/server/src/auth.js
+++ b/server/src/auth.js
@@ -142,17 +142,21 @@ function parseCookies(req) {
 function getSession(req) {
   return verifySession(parseCookies(req)[COOKIE_NAME]);
 }
+// Cookie 属性统一构造：登录与注销必须完全一致，否则浏览器会因 Secure 标志不匹配
+// 而拒绝覆盖旧 Cookie —— BUG-3：此前登录在 ADMIN_ALLOW_HTTP=1 下不带 Secure，
+// 注销却固定带 Secure，http 部署（非 localhost）点「退出登录」后会话仍然有效。
+function sessionCookieAttrs(maxAgeSec) {
+  const secure = process.env.ADMIN_ALLOW_HTTP === '1' ? '' : 'Secure; ';
+  return `HttpOnly; ${secure}SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
+}
 function setSessionCookie(res, payload) {
   const cookie = signSession(payload);
   // ADMIN_ALLOW_HTTP=1（仅本地开发直连 http 时启用）下不附加 Secure，
   // 使浏览器可在 http 上下文持有登录态；生产环境不设该变量，cookie 仍强制 Secure。
-  const secure = process.env.ADMIN_ALLOW_HTTP === '1' ? '' : 'Secure; ';
-  const attrs = `HttpOnly; ${secure}SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`;
-  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${cookie}; ${attrs}`);
+  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${cookie}; ${sessionCookieAttrs(Math.floor(SESSION_TTL / 1000))}`);
 }
 function clearSessionCookie(res) {
-  const attrs = `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
-  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${attrs}`);
+  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${sessionCookieAttrs(0)}`);
 }
 
 // 协议白名单：仅允许经反向代理且原始请求为 HTTPS 时携带管理类凭证。
diff --git a/server/src/compat.js b/server/src/compat.js
index 2c95276..84c66ac 100644
--- a/server/src/compat.js
+++ b/server/src/compat.js
@@ -9,18 +9,7 @@ const db = require('./db');
 const { asyncHandler } = require('./util');
 // 审查 C4：公开兼容层的重聚合（720h 全窗、未认证即可触发）移 worker 线程
 const { heavyQuery } = require('./heavy-db');
-
-const OFFLINE_SEC = () => Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
-const offlineMs = () => OFFLINE_SEC() * 1000;
-// 精确心跳语义：基于 last_seen 与可配置阈值判断 online，
-// 并额外透出 ttl（距判定离线的剩余毫秒，负数表示已离线多久），供高级主题精确渲染。
-function isOnline(a) {
-  const ttl = offlineMs() - (Date.now() - (a.last_seen || 0));
-  return ttl > 0;
-}
-function onlineTtl(a) {
-  return offlineMs() - (Date.now() - (a.last_seen || 0));
-}
+const { isOnline, onlineTtl } = require('./online');
 
 // 历史曲线时间窗（与 api.js RANGES 保持一致）
 const RANGES_C = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };
diff --git a/server/src/online.js b/server/src/online.js
new file mode 100644
index 0000000..b250636
--- /dev/null
+++ b/server/src/online.js
@@ -0,0 +1,36 @@
+'use strict';
+// 在线判定的唯一真源。
+//
+// 历史问题（BUG-1）：/api/agents 按「节点 > 分组 > 全局」解析 offlineSec，
+// 而 /api/agents/:id、/api/overview、/api/public/*、/api/v1/*、/api/nodes 直接读
+// process.env.OFFLINE_THRESHOLD_SEC——同一个节点在不同页面同时显示在线与离线。
+// 这里把解析逻辑收敛到一处，所有对外接口与告警检查共用。
+const db = require('./db');
+const alerts = require('./alerts');
+
+// 预取覆盖表，供批量接口（agents/overview）一次查询、多次复用。
+function buildCtx() {
+  return {
+    global: db.resolveAlertThresholds(),
+    groupCache: new Map(db.listGroupAlertOverrides().map((r) => [r.grp, r])),
+    nodeCache: new Map(db.listAlertOverrides().map((r) => [r.agent_id, r]))
+  };
+}
+
+function effectiveOfflineMs(a, ctx) {
+  return alerts.resolveAgentThresholds(a, ctx).offlineSec * 1000;
+}
+
+// 从未上报（last_seen 为 0/null）的节点一律视为离线，但由调用方决定是否展示；
+// 告警侧另有「从未上报不告警」的宽限（见 alerts.checkAgent）。
+function isOnline(a, now = Date.now(), ctx) {
+  if (!a || !a.last_seen) return false;
+  return now - a.last_seen < effectiveOfflineMs(a, ctx);
+}
+
+// 距判定离线的剩余毫秒（负数 = 已离线多久），供兼容层透出 ttl。
+function onlineTtl(a, now = Date.now(), ctx) {
+  return effectiveOfflineMs(a, ctx) - (now - ((a && a.last_seen) || 0));
+}
+
+module.exports = { buildCtx, effectiveOfflineMs, isOnline, onlineTtl };
diff --git a/server/src/v1.js b/server/src/v1.js
index 52ab91b..f8a6186 100644
--- a/server/src/v1.js
+++ b/server/src/v1.js
@@ -6,9 +6,7 @@
 const express = require('express');
 const db = require('./db');
 const router = express.Router();
-
-const offlineMs = () => Number(process.env.OFFLINE_THRESHOLD_SEC || 60) * 1000;
-const isOnline = (a) => (Date.now() - (a.last_seen || 0)) <= offlineMs();
+const { isOnline } = require('./online');
 
 // 统一响应信封：{ code, message, data }
 function ok(res, data) { res.json({ code: 0, message: '', data }); }
diff --git a/server/web/src/utils/i18n/coverage.test.ts b/server/web/src/utils/i18n/coverage.test.ts
index 8c82684..c41040f 100644
--- a/server/web/src/utils/i18n/coverage.test.ts
+++ b/server/web/src/utils/i18n/coverage.test.ts
@@ -1,3 +1,9 @@
+// @vitest-environment node
+// 本用例只做文件扫描，不碰 DOM。vitest.config 默认 environment=jsdom，
+// 而 jsdom 下 vite 会把 node:path 外部化成浏览器空实现，
+// path.resolve 因此变成 undefined（TypeError: default.resolve is not a function），
+// 整个文件 0 test、CI 必红。显式声明 node 环境即可。
+//
 // i18n 覆盖守卫：扫描源码里所有静态 t('key')，断言键在中英词典中都存在且两边对齐。
 //
 // 为什么需要：t() 未命中时 useI18n 直接返回 key 本身，页面会出现
```
