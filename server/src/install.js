'use strict';
// 安装向导（复刻 komari web/install/install.go 的机制，适配 diting 的单管理员 Token 模型）。
//
// 与 komari 的对应关系：
//   komari：users 表为空 = 未安装（唯一判据，无安装标志位），启动独立 guide server，
//           其他 API 一律 404、页面 GET 一律 307 → /install；
//   diting：getAdminToken() 为空 = 未安装（同样唯一判据，不引入额外标志位），
//           同一 Express 实例内由 server.js 的 installGate 收敛管理面 + 页面 307；
//           agent 上报面（/api/v1/*、/api/report 等）与 SETUP_TOKEN 自助注册不受影响。
//
// 三层防重复安装（对应 komari：内存状态机 → DB users 计数 → 完成后路由消失）：
//   1. 内存状态机 state（ready → completing/completed），非 ready 一律 409 Conflict；
//   2. 已存在可用 ADMIN_TOKEN（getAdminToken()）→ 410 Gone；
//   3. admin_config.admin_initialized 抢锁（setConfigIfAbsent，防多实例竞态）→ 410 Gone。
//   complete 失败回滚锁，向导保持可用（对应 komari createAccountAndSettings 的回滚语义）。
//   安装完成后本模块 API 形同消失：complete → 410，status → required:false（前端据此锁定）。

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { rateLimitTouch } = require('./ratelimit');
const { getAdminToken, MIN_LEN } = require('./token-policy');
const { requireProto } = require('./auth');

const router = express.Router();

// ---- 内存状态机（对应 komari Controller.state 的 ready/completing/completed）----
let state = 'ready';
function getState() { return state; }

// 「是否需要安装」的唯一判据：无可用 Admin Token（口径与 /api/setup/status 完全一致，
// 同时与 token-policy 的启动告警、/metrics 的 401 语义对齐——占位符 / <16 位视为未设置）。
function needsInstall() { return !getAdminToken(); }

// 初始化端点限流（与 /api/setup/generate 同口径）：每 IP 每 60s 最多 5 次。
const WINDOW = 60000, MAX = 5;
const hits = new Map();
const installRateLimit = (req, res, next) => {
  if (!rateLimitTouch(hits, req.ip || req.socket.remoteAddress, WINDOW, MAX)) {
    return res.status(429).json({ error: 'too many requests' });
  }
  next();
};

// GET /api/install/status：前端向导探测。required=false 时前端显示「已初始化」锁定视图。
router.get('/status', (req, res) => {
  res.json({ state: getState(), required: needsInstall() });
});

// ---- 请求校验（对应 komari completeRequest 校验：sitename 1~100、description ≤1000）----
function validateInstall(body) {
  const sitename = String(body.sitename || '').trim();
  const description = String(body.description || '').trim();
  const mode = body.token_mode === 'custom' ? 'custom' : 'generate';
  if (!sitename || sitename.length > 100) {
    return { error: 'invalid_sitename', message: '站点名称必须为 1~100 个字符' };
  }
  if (description.length > 1000) {
    return { error: 'invalid_description', message: '站点描述不能超过 1000 个字符' };
  }
  let token = '';
  if (mode === 'custom') {
    token = String(body.token || '').trim();
    // diting 口径（token-policy）：≥16 位且非占位符。占位符提示给出具体原因。
    if (!token) {
      return { error: 'weak_token', message: '自定义 Token 不能为空' };
    }
    if (token === 'change-me-admin-token') {
      return { error: 'weak_token', message: '自定义 Token 不能使用示例占位符' };
    }
    if (token.length < MIN_LEN) {
      return { error: 'weak_token', message: `自定义 Token 至少 ${MIN_LEN} 个字符` };
    }
    // 复刻 komari 密码强度检查的精神（挡"够长但可猜"的值），口径对齐
    // /api/setup/register 的 isWeakSetupToken：纯数字、字符种类过少、连续序列一律拒绝。
    if (/^\d+$/.test(token) || new Set(token).size <= 4) {
      return { error: 'weak_token', message: '自定义 Token 强度不足（纯数字或字符种类过少），建议使用 openssl rand -hex 32 生成' };
    }
    if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf)/i.test(token)) {
      return { error: 'weak_token', message: '自定义 Token 含连续序列（如 1234/abcd），强度不足' };
    }
  }
  return { sitename, description, mode, token };
}

// 写 .env（唯一来源）：替换已有 ADMIN_TOKEN 行或追加；原子写（tmp + rename）+ 600 权限。
// 与 /api/setup/generate 同一套语义；DITING_ENV_PATH 仅供测试重定向写入位置。
function writeAdminTokenEnv(token) {
  const envPath = process.env.DITING_ENV_PATH || path.join(__dirname, '..', '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf-8'); } catch { /* .env 不存在则创建 */ }
  if (/^ADMIN_TOKEN=/m.test(content)) {
    content = content.replace(/^ADMIN_TOKEN=.*/m, `ADMIN_TOKEN=${token}`);
  } else {
    content += (content.endsWith('\n') ? '' : '\n') + `ADMIN_TOKEN=${token}\n`;
  }
  const tmpPath = envPath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  try { fs.chmodSync(tmpPath, 0o600); } catch { /* 某些文件系统不支持 chmod，忽略 */ }
  fs.renameSync(tmpPath, envPath);
}

// POST /api/install/complete：单步提交站点信息 + 管理员凭据（对应 komari complete）。
// 注意：requireProto 是「返回 boolean 的辅助函数」而非 Express 中间件（auth.js 内部
// 均以 if (!requireProto(req, res)) return; 调用），直接挂载会导致请求永久挂起。
router.post('/complete', installRateLimit, (req, res) => {
  if (!requireProto(req, res)) return; // 管理类凭证与 /api/setup/generate 同口径：必须经 HTTPS 反代
  // 三层防重装之 ①：内存状态机。completing/completed 状态一律 409（同步 handler，无并发窗口）。
  if (state !== 'ready') {
    return res.status(409).json({ error: 'already_completed', message: '安装已完成或正在进行中' });
  }
  // 三层防重装之 ②：已存在可用 Token（外部 .env / 环境变量先于向导配置的场景）。
  if (getAdminToken()) {
    state = 'completed';
    return res.status(410).json({
      error: 'already_initialized',
      message: '管理员 Token 已存在，安装向导已禁用。重置 Token 请通过 SSH 运行：sudo bash diting.sh --reset-admin-token'
    });
  }
  const v = validateInstall(req.body || {});
  if (v.error) {
    return res.status(400).json({ error: v.error, message: v.message });
  }
  // 三层防重装之 ③：DB 初始化锁（防多实例/cluster 竞态，只有抢到锁的实例能继续）。
  if (!db.setConfigIfAbsent('admin_initialized', '1')) {
    return res.status(410).json({
      error: 'already_initialized',
      message: '另一实例已完成初始化（admin_initialized 锁已置位）。重置 Token 请通过 SSH 运行：sudo bash diting.sh --reset-admin-token'
    });
  }
  const token = v.mode === 'custom' ? v.token : 'adm_' + crypto.randomBytes(16).toString('hex');
  try {
    writeAdminTokenEnv(token);
  } catch (e) {
    // 回滚锁（对应 komari 设置写入失败删账户的回滚语义），向导保持可用可重试。
    db.deleteConfig('admin_initialized');
    console.error('[install] 写入 .env 失败:', e.message);
    return res.status(500).json({ error: 'write_failed', message: '写入 .env 失败，请检查文件系统权限与磁盘空间' });
  }
  // 同步更新进程环境变量，本进程内后续请求立即生效
  process.env.ADMIN_TOKEN = token;
  // 站点信息并入 ui_settings（merge 写入，避免整体覆盖抹掉其他键）
  const ui = db.getUiSettings();
  db.setUiSettings(Object.assign({}, ui, { site_title: v.sitename, site_description: v.description }));
  state = 'completed';
  console.log('[install] 安装向导完成：管理员 Token 已写入 .env（600），站点信息已保存；/api/install/* 自此禁用');
  // generate 模式回显一次性 Token；custom 模式不回显（前端已有明文）
  res.json({ status: 'success', token: v.mode === 'generate' ? token : '' });
});

module.exports = { router, needsInstall, getState };
