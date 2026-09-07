const https = require('https');
const nodemailer = require('nodemailer');
const db = require('./db');
const { daysUntil } = require('./util');

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 邮件通道：从「设置中心 / 环境变量」读取，每次发送时动态构建（使 UI 改动即时生效，无需重启）。
function mailTransport() {
  const c = db.getNotifyConfig();
  if (!c.smtp_user || !c.smtp_pass) return null;
  return nodemailer.createTransport({
    host: c.smtp_host || 'smtp.qq.com',
    port: Number(c.smtp_port || 465),
    secure: c.smtp_secure !== false,
    auth: { user: c.smtp_user, pass: c.smtp_pass }
  });
}

// 通过 Telegram Bot API 发送消息。返回 Promise，但任何错误都在内部吞掉，
// 绝不让电报故障影响邮件通道或告警主流程。
function sendTelegram(text) {
  return new Promise((resolve) => {
    const c = db.getNotifyConfig();
    if (!c.telegram_bot_token || !c.telegram_chat_id) return resolve();
    const payload = JSON.stringify({
      chat_id: c.telegram_chat_id,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${c.telegram_bot_token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', (c2) => { body += c2; });
      res.on('end', () => {
        if (res.statusCode !== 200) console.error('[alerts] telegram http', res.statusCode, body);
        resolve();
      });
    });
    req.on('error', (e) => { console.error('[alerts] telegram error:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

async function sendAlert(subject, text) {
  const c = db.getNotifyConfig();
  // 通道一：邮件
  const transporter = mailTransport();
  if (transporter) {
    try {
      await transporter.sendMail({
        from: c.alert_from || c.smtp_user,
        to: c.alert_to || c.smtp_user,
        subject,
        text
      });
      console.log('[alerts] mail sent:', subject);
    } catch (e) {
      console.error('[alerts] mail error:', e.message);
    }
  }
  // 通道二：Telegram（HTML 转义，防止标题/正文里的特殊字符破坏解析）
  if (c.telegram_bot_token && c.telegram_chat_id) {
    try {
      await sendTelegram(`<b>${escapeHtml(subject)}</b>\n\n${escapeHtml(text)}`);
      console.log('[alerts] telegram sent:', subject);
    } catch (e) {
      console.error('[alerts] telegram error:', e.message);
    }
  }
}

async function alertThreshold(agent, type, msg, now, cooldown) {
  const st = db.getAlertState(agent.id, type);
  if (!st || now - st.last_sent > cooldown * 1000) {
    db.setAlertState(agent.id, type, now);
    await sendAlert(`[监控] ${agent.name} ${type} 告警`, `客户端 ${agent.name}(${agent.id}) ${msg}。`);
  }
}

// 单个 agent 的检查。返回 Promise（可能为空）。
// 注意：db.setAlertState 必须在 await sendAlert 之前同步写入 —— better-sqlite3 为同步 API，
// 这样即便定时任务重入也不会重复发信（冷却窗口已在此点生效）。
function checkAgent(a, now, cfg) {
  try {
    const online = a.last_seen && (now - a.last_seen) < cfg.offlineSec * 1000;
    if (!online) {
      const st = db.getAlertState(a.id, 'offline');
      if (!st || now - st.last_sent > cfg.cooldown * 1000) {
        db.setAlertState(a.id, 'offline', now);
        return sendAlert(`[监控] ${a.name} 离线`, `客户端 ${a.name}(${a.id}) 已超过 ${cfg.offlineSec}s 未上报，可能已宕机或断网。`);
      }
      return null;
    }
    // recovered -> allow future offline alerts
    db.clearAlertState(a.id, 'offline');
    const m = db.getLatestMetric(a.id);
    if (!m) return null;
    const jobs = [];
    if (m.cpu >= cfg.cpuAlert) jobs.push(alertThreshold(a, 'cpu', `CPU ${m.cpu.toFixed(1)}% >= ${cfg.cpuAlert}%`, now, cfg.cooldown));
    if (m.mem_pct >= cfg.memAlert) jobs.push(alertThreshold(a, 'mem', `内存 ${m.mem_pct.toFixed(1)}% >= ${cfg.memAlert}%`, now, cfg.cooldown));
    return Promise.allSettled(jobs);
  } catch (e) {
    // 单个 agent 异常（如 DB 读取失败）不应中断其余 agent 的告警检查
    console.error(`[alerts] check failed for agent ${a.id}:`, e.message);
    return null;
  }
}

// 重入保护：check 是 async 的，而 setInterval 会周期性触发。若上一轮因等待 SMTP/Telegram
// 尚未结束（节点多或通知通道超时时可能发生），本轮直接跳过，避免并发叠加放大负载。
let checkRunning = false;

async function check() {
  if (checkRunning) {
    console.warn('[alerts] 上一轮检查尚未结束，跳过本次触发（节点数增长或通知通道超时时可能看到）');
    return false;
  }
  checkRunning = true;
  const t0 = Date.now();
  try {
    const agents = db.getAgents();
    const now = Date.now();
    // 阈值优先取「设置中心 / UI 配置」（前端可改），缺失时回退到 docker-compose 环境变量默认值。
    const ui = db.getUiSettings();
    const alertCfg = (ui && ui.alert) || {};
    const cfg = {
      offlineSec: Number(alertCfg.offline_sec || process.env.OFFLINE_THRESHOLD_SEC || 60),
      cpuAlert: Number(alertCfg.cpu_pct || process.env.ALERT_CPU_PCT || 90),
      memAlert: Number(alertCfg.mem_pct || process.env.ALERT_MEM_PCT || 90),
      cooldown: Number(process.env.ALERT_COOLDOWN_SEC || 1800)
    };
    // 限并发而非全并发：SMTP 普遍有速率/连接限制，100 台同时离线时一次性并发易被拒收。
    const CONCURRENCY = Math.max(1, Number(process.env.ALERT_CONCURRENCY || 8));
    for (let i = 0; i < agents.length; i += CONCURRENCY) {
      await Promise.allSettled(agents.slice(i, i + CONCURRENCY).map((a) => checkAgent(a, now, cfg)));
    }
    console.log(`[alerts] check done: ${agents.length} agents in ${Date.now() - t0}ms`);
    return true;
  } finally {
    checkRunning = false;
  }
}

// 检查节点到期预警：白嫖(cycle=0)跳过；临期(<=7天)或已过期触发，冷却 24h。
async function checkExpiringAgents(now) {
  const agents = db.getAgents();
  for (const a of agents) {
    try {
      // 白嫖节点无到期概念，跳过
      if (a.billing_cycle === 0) continue;
      if (!a.expire_at) continue;
      const days = daysUntil(a.expire_at);
      if (days == null) continue;
      if (days <= 7) {
        const st = db.getAlertState(a.id, 'expire');
        if (!st || now - st.last_sent > 24 * 3600 * 1000) {
          db.setAlertState(a.id, 'expire', now);
          const when = days < 0 ? `已过期 ${Math.abs(days)} 天` : `将于 ${days} 天后到期`;
          await sendAlert(
            `[监控] ${a.name} 即将到期`,
            `客户端 ${a.name}(${a.id}) ${when}，到期日 ${a.expire_at}。请及时处理续费或下线，避免服务中断。`
          );
        }
      } else {
        // 远离到期则清除状态，允许未来再次提醒
        db.clearAlertState(a.id, 'expire');
      }
    } catch (e) {
      console.error(`[alerts] checkExpiringAgents failed for ${a.id}:`, e.message);
    }
  }
}

// 检查月流量配额：基于 metrics 最近一条的 net_rx_month+net_tx_month（字节），超 monthly_quota_gb 触发，冷却 24h。
async function checkTrafficQuota(now) {
  const agents = db.getAgents();
  const GIB = 1024 * 1024 * 1024;
  for (const a of agents) {
    try {
      if (!a.monthly_quota_gb || a.monthly_quota_gb <= 0) continue;
      const m = db.getLatestMetric(a.id);
      if (!m) continue;
      const usedGb = ((Number(m.net_rx_month) || 0) + (Number(m.net_tx_month) || 0)) / GIB;
      if (usedGb >= a.monthly_quota_gb) {
        const st = db.getAlertState(a.id, 'quota');
        if (!st || now - st.last_sent > 24 * 3600 * 1000) {
          db.setAlertState(a.id, 'quota', now);
          await sendAlert(
            `[监控] ${a.name} 月流量超额`,
            `客户端 ${a.name}(${a.id}) 本月已用 ${usedGb.toFixed(2)} GB，超过配额 ${a.monthly_quota_gb} GB。请关注是否产生额外费用或被限速。`
          );
        }
      } else {
        db.clearAlertState(a.id, 'quota');
      }
    } catch (e) {
      console.error(`[alerts] checkTrafficQuota failed for ${a.id}:`, e.message);
    }
  }
}

function notifyStatus() {
  const c = db.getNotifyConfig();
  return {
    mail: !!(c.smtp_user && c.smtp_pass),
    telegram: !!(c.telegram_bot_token && c.telegram_chat_id)
  };
}

let timer = null;
let dailyTimer = null;
async function runDailyChecks() {
  const now = Date.now();
  try { await checkExpiringAgents(now); } catch (e) { console.error('[alerts] checkExpiringAgents error:', e.message); }
  try { await checkTrafficQuota(now); } catch (e) { console.error('[alerts] checkTrafficQuota error:', e.message); }
}
function start() {
  const interval = Math.max(10000, (Number(process.env.OFFLINE_THRESHOLD_SEC || 60) * 1000) / 2);
  // unref：定时器不阻止进程退出（对集成测试进程尤其重要）
  timer = setInterval(check, interval);
  timer.unref();
  // 到期/流量为低频事件，每 6 小时检查一次即可，避免与秒级 check 互相干扰。
  dailyTimer = setInterval(runDailyChecks, 6 * 3600 * 1000);
  dailyTimer.unref();
  // 启动后立即跑一次，确保配置生效无需等 6h。
  runDailyChecks();
  console.log('[alerts] checker started');
}

function stop() { if (timer) clearInterval(timer); if (dailyTimer) clearInterval(dailyTimer); }

// 导出 check：便于单测与手动排查（此前未导出，只能靠定时触发观察）。
module.exports = { start, stop, check, sendAlert, notifyStatus, checkExpiringAgents, checkTrafficQuota };
