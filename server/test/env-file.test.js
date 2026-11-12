'use strict';
// ============================================================
// 运行目录分离（L2）：DITING_ENV_FILE 显式指定环境文件路径。
//
// 生产形态：systemd EnvironmentFile 注入 + DITING_ENV_FILE 指向仓库树外的
// server-data/.env；dotenv 必须按该路径加载，而不是 cwd/.env。
// 本测试锁住两点：
//   1. DITING_ENV_FILE 指定的文件被读取；
//   2. 加载发生在 server.js 被 require 的时刻（早于业务初始化）。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'envfile-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-env-file-test.db';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const envFile = path.join(os.tmpdir(), `diting-env-file-${process.pid}.env`);
fs.writeFileSync(envFile, 'PROBE_DITING_ENV=loaded-from-diting-env-file\n');
process.env.DITING_ENV_FILE = envFile;

const { server } = require('../server');

after(async () => {
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  try { fs.unlinkSync(envFile); } catch { /* 已清理 */ }
  try { fs.rmSync(process.env.DB_PATH, { force: true }); } catch { /* 已清理 */ }
});

test('DITING_ENV_FILE 指定的环境文件在 require 时被 dotenv 读取', () => {
  assert.strictEqual(process.env.PROBE_DITING_ENV, 'loaded-from-diting-env-file');
});
