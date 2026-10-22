'use strict';
// ============================================================
// SETUP_TOKEN 解析（D5）：库为权威，env 仅作一次性迁移源。
//
// 两个消费方共用同一份判定，避免"注册端点"和"安装口令"各读一遍、口径漂移：
//   - api.js  /api/setup/register（受控端自助注册）
//   - install.js /api/install/complete 的 install_token 抢占防护（§6.7 / G6）
// ============================================================
const db = require('./db');

// 弱模式判定与 api.js 的 isWeakSetupToken 同口径（纯数字/字符种类过少/含连续序列）。
// 弱令牌**不搬库**：那是配置错误，留在 env 里让每次请求都给出同一条"过弱"提示，
// 而不是把一个不可用的值冻进库（此后改 .env 也不再生效）。
function isWeakSetupToken(t) {
  const s = String(t || '').trim();
  if (s.length < 16) return true;
  if (/^\d+$/.test(s)) return true;
  if (new Set(s).size <= 4) return true;
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf)/i.test(s)) return true;
  return false;
}

function resolveSetupToken() {
  // 管理面显式清除后的墓碑：否则残留的 env 值会被反复搬回来，"清除"形同无效。
  if (db.isSetupTokenCleared()) return { token: '', source: 'cleared' };
  const inDb = db.getSetupToken();
  if (inDb) return { token: inDb, source: 'db' };
  const env = process.env.SETUP_TOKEN;
  if (env && !isWeakSetupToken(env)) { db.setSetupToken(env); return { token: env, source: 'env-migrated' }; }
  if (env) return { token: env, source: 'env-weak' };
  return { token: '', source: 'none' };
}

module.exports = { resolveSetupToken, isWeakSetupToken };
