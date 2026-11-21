'use strict';
// 003：agents 追加列（分组 / 国家 / 探测目标 / 账单 / 版本 / 硬件档案 / 软删等）。
// 列名与类型硬编码常量；只增不删。
const { addColumnsIfMissing } = require('./util');

const COLS = [
  // 分组字段（避免使用 SQL 关键字 group，列名用 grp）
  ['grp', "TEXT DEFAULT ''"],
  // 国家字段（受控端国旗，存 ISO 3166-1 alpha-2 代码，如 CN/US/JP）
  ['country', "TEXT DEFAULT ''"],
  // 探测目标(网络质量自测 DNS)列，服务端可配置、按受控端独立存储
  ['probe_targets', "TEXT DEFAULT ''"],
  // 账单字段（价格 / 计费周期 / 货币 / 自动续费）
  ['price', 'REAL DEFAULT 0'],
  ['billing_cycle', 'INTEGER DEFAULT 30'],
  ['currency', "TEXT DEFAULT '¥'"],
  ['auto_renewal', 'INTEGER DEFAULT 1'],
  // 受控端版本：从上报请求的 User-Agent（diting-agent-go/x.y.z / diting-agent/x.y）解析而来
  ['version', "TEXT DEFAULT ''"],
  // CPU 核数（受控端上报的静态硬件属性，§9 T18）。
  // 语义：0 = 未上报/未知（老 agent 不带该字段）——**不可当作 1 用**，摘要侧会标 cores_unknown。
  // 放 agents 表而不是 metrics 表：静态属性，避免给 2200 万行的 metrics 加列。
  ['cores', 'INTEGER DEFAULT 0'],
  // pending（审查 G4：自助注册的 agent 默认待管理员确认）。
  // 语义：0 = 已确认（ADD COLUMN 默认值即 0，所有历史 agent 不受影响）；1 = 待确认。
  // 待确认期间禁止上报（auth.js agentAuth 拒绝），且不进入看板/公开页/告警/AI 统计
  // （getMonitoredAgents 过滤）——防 SETUP_TOKEN 泄露后被批量注册污染数据与看板。
  ['pending', 'INTEGER DEFAULT 0'],
  // 构建元信息列（V.1：版本可判定性）。
  //   build_sha     编译期 commit 短 sha（7–40 hex；'' = 未知）
  //   build_time    编译期 UTC RFC3339（'' = 未知）
  //   agent_platform 运行平台 linux-amd64 / windows-amd64 / ...
  //   build_tag     管理员标注（'' | 'custom' | 自由标签）——服务端不自动判定官方构建
  ['build_sha', "TEXT DEFAULT ''"],
  ['build_time', "TEXT DEFAULT ''"],
  ['agent_platform', "TEXT DEFAULT ''"],
  ['build_tag', "TEXT DEFAULT ''"],
  // 硬件档案列（管理员手工录入，单列 JSON；'' = 未填写）。
  // 受控端不自动采集硬件指纹，四字段（cpu/arch/virt/gpu）的值全部来自管理面输入，
  // 每个字段支持「预设 / 手填 / 隐藏」三态，结构见 src/hardware-profile.js 头注释。
  ['hw_profile', "TEXT DEFAULT ''"],
  // P1：流量重置日列。三态 NULL=未设置（采纳 agent 上报）/0=累计/1–31=重置日；不给默认值。
  ['month_rotate', 'INTEGER'],
  // F11（2026-10-24）：软删列。删除 = 写 deleted_at（节点立即从全部读路径消失），
  // 7 天缓冲期内可由「最近删除」恢复；到期由 purgeDeletedAgents() 物理删除
  //（此时 FK CASCADE 才带走 metrics / traffic_state）。NULL = 未删除。
  ['deleted_at', 'INTEGER'],
];

module.exports = {
  version: 3,
  name: 'agents-columns',
  up(db) {
    addColumnsIfMissing(db, 'agents', COLS);
  },
};
