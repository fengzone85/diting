'use strict';
// 管理员 Token 的「强度下限」与「校验口径」。
//
// 这不是密码复杂度策略：Token 是纯秘密，没有账号 + 密码那样的多因子与锁定机制，
// 一旦后台或 /metrics 可被直连，攻击者可按 IP 分散枚举。这里只挡两类必然被秒破的配置：
//   1) 示例占位符（change-me-admin-token）；
//   2) 明显过短的值（< MIN_LEN）。
//
// 真实随机性无法在启动期验证（`passwordpassword` 同样能过），生产环境请用
// `openssl rand -hex 32` 生成。判定收敛到本模块，避免 server.js / auth.js / api.js
// 各存一份副本后阈值漂移。
//
// 存储口径（P0）：**库中只存 sha256 哈希**（admin_config.admin_token_hash），
// 明文只存在于用户手里——向导一次性展示、reset 脚本一次性打印。因此本模块不再提供
// "取出明文 Token" 的能力（旧 getAdminToken 已删除），只提供「是否已初始化」与
// 「校验明文是否匹配」。

const crypto = require('crypto');
const db = require('./db');

const MIN_LEN = 16;
const PLACEHOLDER = 'change-me-admin-token';
// sha256 hex 固定 64 位；库里的值不合法（空/脏写/旧明文）一律视为"未初始化"。
const HASH_RE = /^[0-9a-f]{64}$/;

function isUsableAdminToken(t) {
  return typeof t === 'string' && t.length >= MIN_LEN && t !== PLACEHOLDER;
}

// 明文 → 存储哈希。复用 db.hashToken，保证与管理端其它 token 口径一致。
function hashAdminToken(t) {
  return db.hashToken(String(t));
}

// 是否已初始化：库中存在合法的 Token 哈希。
// 这是「未安装 / 已安装」的唯一判据（对齐 komari 的 users 计数语义）。
function hasAdminToken() {
  return HASH_RE.test(db.getAdminTokenHash());
}

// 校验明文 Token 是否与库中哈希匹配。
// 恒定时间：两侧都是 64 字节 hex（等长），直接 timingSafeEqual；长度不等前已由
// HASH_RE 拦掉，不存在"按长度提前返回"的时序侧信道。
function verifyAdminToken(input) {
  if (typeof input !== 'string' || !input) return false;
  // 上限保护：避免超长输入参与哈希（DoS 面），正常 Token 远小于此。
  if (input.length > 4096) return false;
  const stored = db.getAdminTokenHash();
  if (!HASH_RE.test(stored)) return false;
  const got = hashAdminToken(input);
  return crypto.timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(stored, 'utf8'));
}

// null = 可用；其余为具体原因，供启动日志区分「未设置 / 占位符 / 过短」。
function tokenIssue(t) {
  if (!t) return 'missing';
  if (t === PLACEHOLDER) return 'placeholder';
  if (String(t).length < MIN_LEN) return 'too_short';
  return null;
}

module.exports = {
  MIN_LEN, PLACEHOLDER, HASH_RE,
  isUsableAdminToken, tokenIssue, hashAdminToken,
  hasAdminToken, verifyAdminToken,
};
