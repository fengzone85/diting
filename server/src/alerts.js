const https = require('https');
const nodemailer = require('nodemailer');
const db = require('./db');
const { daysUntil } = require('./util');

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 审查 E1：阈值告警需连续 N 个采样超限才触发（单样本 spike 不报），恢复同样
// 需连续确认。ALERT_SUSTAIN_SAMPLES=1 可关闭持续确认（恢复旧的单样本行为）。
const SUSTAIN_N = Math.max(1, Number(process.env.ALERT_SUSTAIN_SAMPLES || 2));

// 邮件通道：从「设置中心 / 环境变量」读取。审查 D3/C-5：transport 按配置指纹
// 缓存复用（此前每次发送都 createTransport），并显式设置连接/问候/socket 三类
// 超时——此前无超时，慢 SMTP 下发送挂起会让"先写 state 后发送"的告警被整个
// 冷却期吞掉。配置变更时指纹变化自动重建实例。
let _mailCache = { fp: '', transporter: null };
function mailTransport() {
  const c = db.getNotifyConfig();
  if (!c.smtp_user || !c.smtp_pass) return null;
  const fp = JSON.stringify([c.smtp_host, c.smtp_port, c.smtp_secure, c.smtp_user, c.smtp_pass]);
  if (_mailCache.fp !== fp || !_mailCache.transporter) {
    _mailCache = {
      fp,
      transporter: nodemailer.createTransport({
        host: c.smtp_host || 'smtp.qq.com',
        port: Number(c.smtp_port || 465),
        secure: c.smtp_secure !== false,
        auth: { user: c.smtp_user, pass: c.smtp_pass },
        connectionTimeout: 10000,  // TCP 建连
        greetingTimeout: 10000,    // SMTP 220 问候
        socketTimeout: 20000       // socket 空闲
      })
    };
  }
  return _mailCache.transporter;
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
    // 审查 D3/C-5：Telegram 请求补超时（此前无超时，挂起会拖住整个告警轮）
    req.setTimeout(15000, () => { req.destroy(); });
    req.write(payload);
    req.end();
  });
}

// 返回是否至少一个通道发送成功——供调用方在失败时回滚 alert state（审查 D3）。
async function sendAlert(subject, text) {
  const c = db.getNotifyConfig();
  let ok = false;
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
      ok = true;
      console.log('[alerts] mail sent:', subject);
    } catch (e) {
      console.error('[alerts] mail error:', e.message);
    }
  }
  // 通道二：Telegram（HTML 转义，防止标题/正文里的特殊字符破坏解析）
  if (c.telegram_bot_token && c.telegram_chat_id) {
    try {
      await sendTelegram(`<b>${escapeHtml(subject)}</b>\n\n${escapeHtml(text)}`);
      ok = true;
      console.log('[alerts] telegram sent:', subject);
    } catch (e) {
      console.error('[alerts] telegram error:', e.message);
    }
  }
  return ok;
}

// 审查 D3：带"失败回滚"的告警发送。先同步写 state 占位（冷却即时生效，防定时
// 任务重入重复发信），发送失败立即清除 state——下一轮重试，避免通道故障把
// 后续告警吞掉整个冷却期。
async function sendAlertGuarded(agentId, type, subject, text) {
  db.setAlertState(agentId, type, Date.now());
  const ok = await sendAlert(subject, text);
  if (!ok) db.clearAlertState(agentId, type);
  return ok;
}

async function alertThreshold(agent, type, msg, now, cooldown) {
  const st = db.getAlertState(agent.id, type);
  if (!st || now - st.last_sent > cooldown * 1000) {
    await sendAlertGuarded(agent.id, type, `[监控] ${agent.name} ${type} 告警`, `客户端 ${agent.name}(${agent.id}) ${msg}。`);
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
        return sendAlertGuarded(a.id, 'offline', `[监控] ${a.name} 离线`, `客户端 ${a.name}(${a.id}) 已超过 ${cfg.offlineSec}s 未上报，可能已宕机或断网。`);
      }
      return null;
    }
    // recovered -> allow future offline alerts
    db.clearAlertState(a.id, 'offline');
    const m = db.getLatestMetric(a.id);
    if (!m) return null;
    // 审查 E1：连续 N 个采样超限才触发（单样本 spike 不报），恢复同样需连续
    // 确认，并补"已恢复"通知——此前 cpu/mem 的 alert state 从不清理，指标降回
    // 正常后无任何感知，且下次超阈会被旧 state 的冷却压住。
    const recent = db.getRecentMetrics(a.id, SUSTAIN_N);
    const jobs = [];
    const checkMetric = (type, field, limit, unit, label) => {
      const vals = recent.map((r) => r[field]).filter((v) => typeof v === 'number');
      if (vals.length < SUSTAIN_N) return; // 样本不足：本轮不判定（宁可不报，不可误报）
      const newest = vals.slice(-SUSTAIN_N);
      const st = db.getAlertState(a.id, type);
      if (newest.every((v) => v >= limit)) {
        if (!st || now - st.last_sent > cfg.cooldown * 1000) {
          const cur = vals[vals.length - 1];
          jobs.push(alertThreshold(a, type, `${label} 连续 ${SUSTAIN_N} 个采样 ≥ ${limit}${unit}（当前 ${cur.toFixed(1)}${unit}）`, now, cfg.cooldown));
        }
      } else if (st && newest.every((v) => v < limit)) {
        // 持续低于阈值：发一次"已恢复"并清状态（清除后不会重复发送）
        db.clearAlertState(a.id, type);
        jobs.push(sendAlert(`[监控] ${a.name} ${label} 已恢复`, `客户端 ${a.name}(${a.id}) ${label} 已连续 ${SUSTAIN_N} 个采样低于 ${limit}${unit}。`));
      }
    };
    checkMetric('cpu', 'cpu', cfg.cpuAlert, '%', 'CPU');
    checkMetric('mem', 'mem_pct', cfg.memAlert, '%', '内存');
    // 审查 E6：补磁盘/温度告警（disk_pct/temp 一直采集，此前无规则）
    checkMetric('disk', 'disk_pct', cfg.diskAlert, '%', '磁盘');
    checkMetric('temp', 'temp', cfg.tempAlert, '°C', '温度');
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
    // 待确认 agent 尚未获准上报，不参与告警（审查 G4，否则被误判"离线"刷误报）
    const agents = db.getMonitoredAgents();
    const now = Date.now();
    // 审查 C-1/E2：阈值单一取值（UI 显式值 > env > 默认）。
    // 此前直接读 getUiSettings().alert——其嵌套合并使默认值恒真，env 分支不可达，
    // 导致看板（直读 env）与告警（UI 默认）对"在线"的判断不一致、平稳期误报离线。
    const t = db.resolveAlertThresholds();
    const cfg = {
      offlineSec: t.offline_sec,
      cpuAlert: t.cpu_pct,
      memAlert: t.mem_pct,
      diskAlert: t.disk_pct,
      tempAlert: t.temp_c,
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
  const agents = db.getMonitoredAgents();
  for (const a of agents) {
    try {
      // 白嫖节点无到期概念，跳过
      if (a.billing_cycle === 0) continue;
      if (!a.expire_at) continue;
      const days = daysUntil(a.expire_at);
      if (days == null) continue;
      if (days <= 7) {
        // 审查 E4：已过期改独立终态——单独 type + 7 天冷却。此前已过期节点与
        // 临期共用 24h 冷却，"已过期 N 天"每 24h 永动且 N 无限增长；恢复有效期
        // 则清除终态，允许未来重新提醒。
        const expired = days < 0;
        const type = expired ? 'expired' : 'expire';
        const cooldownMs = expired ? 7 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
        const st = db.getAlertState(a.id, type);
        if (!st || now - st.last_sent > cooldownMs) {
          const when = expired ? '已过期' : `将于 ${days} 天后到期`;
          await sendAlertGuarded(a.id, type,
            `[监控] ${a.name} ${expired ? '已过期' : '即将到期'}`,
            `客户端 ${a.name}(${a.id}) ${when}${expired ? '' : `，到期日 ${a.expire_at}`}。请及时处理续费或下线，避免服务中断。`);
        }
        if (!expired) db.clearAlertState(a.id, 'expired');
      } else {
        // 远离到期则清除状态，允许未来再次提醒
        db.clearAlertState(a.id, 'expire');
        db.clearAlertState(a.id, 'expired');
      }
    } catch (e) {
      console.error(`[alerts] checkExpiringAgents failed for ${a.id}:`, e.message);
    }
  }
}

// 检查月流量配额：基于 metrics 最近一条的 net_rx_month+net_tx_month（字节），超 monthly_quota_gb 触发，冷却 24h。
async function checkTrafficQuota(now) {
  const agents = db.getMonitoredAgents();
  const GIB = 1024 * 1024 * 1024;
  for (const a of agents) {
    try {
      if (!a.monthly_quota_gb || a.monthly_quota_gb <= 0) continue;
      const m = db.getLatestMetric(a.id);
      if (!m) continue;
      const usedGb = ((Number(m.net_rx_month) || 0) + (Number(m.net_tx_month) || 0)) / GIB;
      // 审查 E5：服务端速率积分交叉校验受控端上报的月累计。接口计数重置或
      // agent state.json 丢失时上报差值被钳零 → 配额检查静默漏报；两侧偏差
      // 超过一半且服务端估算 >1GB 时，告警"计数不可信"提醒人工核对。
      try {
        const est = db.trafficEstimateBucketed(a.id, now - 30 * 86400000);
        const estGb = (est.rx + est.tx) / GIB;
        if (estGb > 1 && usedGb < estGb * 0.5) {
          const st = db.getAlertState(a.id, 'traffic_untrusted');
          if (!st || now - st.last_sent > 24 * 3600 * 1000) {
            await sendAlertGuarded(a.id, 'traffic_untrusted',
              `[监控] ${a.name} 月流量计数不可信`,
              `客户端 ${a.name}(${a.id}) 上报本月 ${usedGb.toFixed(2)}GB，服务端按速率积分估算约 ${estGb.toFixed(2)}GB，偏差过大——可能接口计数已重置或本地状态丢失，配额告警可能漏报，请人工核对。`);
          }
        } else {
          db.clearAlertState(a.id, 'traffic_untrusted');
        }
      } catch (e) { /* 交叉校验失败不影响配额主流程 */ }
      if (usedGb >= a.monthly_quota_gb) {
        const st = db.getAlertState(a.id, 'quota');
        if (!st || now - st.last_sent > 24 * 3600 * 1000) {
          await sendAlertGuarded(a.id, 'quota',
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
// 审查 D2：daily 任务同样加重入保护（此前只有主 check 有）——慢 SMTP 下多轮
// 叠加会重复发信。跳过轮次计数写日志，便于观测通道健康状况。
let dailyRunning = false;
let dailySkips = 0;
async function runDailyChecks() {
  if (dailyRunning) {
    dailySkips++;
    console.warn(`[alerts] 上一轮 daily 检查尚未结束，跳过本次（累计跳过 ${dailySkips} 次）`);
    return;
  }
  dailyRunning = true;
  const now = Date.now();
  try {
    try { await checkExpiringAgents(now); } catch (e) { console.error('[alerts] checkExpiringAgents error:', e.message); }
    try { await checkTrafficQuota(now); } catch (e) { console.error('[alerts] checkTrafficQuota error:', e.message); }
  } finally {
    dailyRunning = false;
  }
}
// 审查 E2：离线阈值 vs 观测上报间隔的一致性自检（启动时执行一次）。
// 服务端无法读取 agent 侧 SLOW_INTERVAL（agent 侧 env），改用观测到的相邻 ts 中位数：
// 阈值 < 2× 观测间隔时平稳期必然周期性误报离线——显式告警而非静默误报。
function checkOfflineThresholdSanity() {
  let offlineSec = 60;
  try { offlineSec = db.resolveAlertThresholds().offline_sec; } catch (e) { return; }
  for (const a of db.getMonitoredAgents()) {
    let sec = null;
    try { sec = db.observedIntervalSec(a.id); } catch (e) { continue; }
    if (sec && offlineSec < sec * 2) {
      console.warn(`[alerts] 离线阈值 ${offlineSec}s 小于 agent ${a.name}(${a.id}) 观测上报间隔 ${sec}s 的 2 倍——平稳期将周期性误报离线。请调大「设置中心离线阈值」或 OFFLINE_THRESHOLD_SEC。`);
    }
  }
}
function start() {
  // 检查节奏同样按生效的离线阈值推导（阈值收敛后与告警判定同源）
  let offlineSec = 60;
  try { offlineSec = db.resolveAlertThresholds().offline_sec; } catch (e) {}
  const interval = Math.max(10000, (offlineSec * 1000) / 2);
  // unref：定时器不阻止进程退出（对集成测试进程尤其重要）
  timer = setInterval(check, interval);
  timer.unref();
  // 到期/流量为低频事件，每 6 小时检查一次即可，避免与秒级 check 互相干扰。
  dailyTimer = setInterval(runDailyChecks, 6 * 3600 * 1000);
  dailyTimer.unref();
  // 启动后立即跑一次，确保配置生效无需等 6h。
  runDailyChecks();
  // 审查 E2：阈值 vs 观测间隔一致性自检（显式告警，不阻断启动）
  try { checkOfflineThresholdSanity(); } catch (e) { /* 自检失败不影响主流程 */ }
  console.log('[alerts] checker started');
}

function stop() { if (timer) clearInterval(timer); if (dailyTimer) clearInterval(dailyTimer); }

// 导出 check / checkAgent：便于单测与手动排查（此前未导出，只能靠定时触发观察）。
// checkAgent 供 E1（连续 N 采样 / 恢复通知）与 E6（disk/temp 告警）的回归断言直接驱动。
module.exports = { start, stop, check, checkAgent, sendAlert, notifyStatus, checkExpiringAgents, checkTrafficQuota };
