'use strict';
// Bearer Token 的「熵下限」判定。
//
// 这不是密码复杂度策略：Token 是纯秘密，没有账号 + 密码那样的多因子与锁定机制，
// 一旦后台或 /metrics 可被直连，攻击者可按 IP 分散枚举。这里只挡两类必然被秒破的配置：
//   1) 示例占位符（change-me-admin-token）；
//   2) 明显过短的值（< MIN_LEN）。
//
// 真实随机性无法在启动期验证（`passwordpassword` 同样能过），生产环境请用
// `openssl rand -hex 32` 生成。判定收敛到本模块，避免 server.js / auth.js / api.js
// 各存一份副本后阈值漂移。

const MIN_LEN = 16;
const PLACEHOLDER = 'change-me-admin-token';

function isUsableAdminToken(t) {
  return typeof t === 'string' && t.length >= MIN_LEN && t !== PLACEHOLDER;
}

// 返回 '' 表示「不可用」——调用方据此走 Web 初始化向导。
function getAdminToken() {
  const t = process.env.ADMIN_TOKEN;
  return isUsableAdminToken(t) ? t : '';
}

// null = 可用；其余为具体原因，供启动日志区分「未设置 / 占位符 / 过短」。
function tokenIssue(t) {
  if (!t) return 'missing';
  if (t === PLACEHOLDER) return 'placeholder';
  if (String(t).length < MIN_LEN) return 'too_short';
  return null;
}

module.exports = { MIN_LEN, PLACEHOLDER, getAdminToken, isUsableAdminToken, tokenIssue };
