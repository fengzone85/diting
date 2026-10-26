import { describe, it, expect } from 'vitest';
import { compareVer, isOlderVersion, normalizeVer } from './version';

describe('normalizeVer', () => {
  it('去掉 v 前缀', () => {
    expect(normalizeVer('v1.1.4')).toBe('1.1.4');
    expect(normalizeVer(' V1.1.4 ')).toBe('1.1.4');
    expect(normalizeVer(null)).toBe('');
  });
  it('从完整 release tag 里提取版本号（真实回归场景）', () => {
    // 服务端的 agent_latest 是完整 tag，不是裸版本号
    expect(normalizeVer('agent-go-v1.1.3')).toBe('1.1.3');
    expect(normalizeVer('agent-go-v1.10.2')).toBe('1.10.2');
  });
});

describe('compareVer', () => {
  it('按数字段比较（不是字符串比较）', () => {
    expect(compareVer('1.1.4', '1.1.3')).toBe(1);
    expect(compareVer('1.1.3', '1.1.4')).toBe(-1);
    expect(compareVer('1.1.4', 'v1.1.4')).toBe(0);
    expect(compareVer('1.10.0', '1.9.9')).toBe(1);   // 字符串比较会错
    expect(compareVer('2', '1.99.99')).toBe(1);
  });
  it('缺段按 0 处理', () => {
    expect(compareVer('1.1', '1.1.0')).toBe(0);
    expect(compareVer('1.1.1', '1.1')).toBe(1);
  });
  it('预发布后缀不导致「落后」误判', () => {
    expect(compareVer('1.1.4-rc1', '1.1.4')).toBe(0);
  });
});

describe('isOlderVersion：只有确实更低才算可升级', () => {
  it('低于最新 → true', () => {
    expect(isOlderVersion('1.1.2', '1.1.3')).toBe(true);
  });
  it('等于最新 → false', () => {
    expect(isOlderVersion('1.1.4', 'v1.1.4')).toBe(false);
  });
  it('高于最新（本地自建构建）→ false（这是曾经的误报场景）', () => {
    expect(isOlderVersion('1.1.4', '1.1.3')).toBe(false);
  });
  it('完整 tag 作为最新版时也能正确比较（真实回归场景）', () => {
    expect(isOlderVersion('1.1.2', 'agent-go-v1.1.3')).toBe(true);   // 旧节点确实落后
    expect(isOlderVersion('1.1.4', 'agent-go-v1.1.3')).toBe(false);  // 自建新版不误报
    expect(isOlderVersion('1.1.3', 'agent-go-v1.1.3')).toBe(false);  // 相等
  });
  it('任一侧未知 → false（不把未知说成可升级）', () => {
    expect(isOlderVersion('', '1.1.3')).toBe(false);
    expect(isOlderVersion('1.1.2', '')).toBe(false);
  });
});
