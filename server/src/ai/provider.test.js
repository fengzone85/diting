'use strict';
// provider.js 纯函数单测（**不联网**）
//   - parseAnalysis：模型输出常带 markdown 围栏 / 前后废话，需容错解析
//   - checkBaseUrl：SSRF 防护——云元数据地址必须拒绝（IP 字面量分支不触发 DNS，故无需联网）
// 运行：cd server && /usr/bin/node --test src/ai/provider.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { parseAnalysis, checkBaseUrl, AiError } = require('./provider');

test('parseAnalysis: 标准 JSON', () => {
  const r = parseAnalysis('{"risk_level":"low","summary":"ok"}');
  assert.strictEqual(r.risk_level, 'low');
});

test('parseAnalysis: 去掉 ```json 围栏', () => {
  const r = parseAnalysis('```json\n{"risk_level":"high"}\n```');
  assert.strictEqual(r.risk_level, 'high');
});

test('parseAnalysis: 容忍 JSON 前后的废话', () => {
  const r = parseAnalysis('好的，以下是分析结果：\n{"risk_level":"medium","highlights":[]}\n以上。');
  assert.strictEqual(r.risk_level, 'medium');
  assert.deepStrictEqual(r.highlights, []);
});

test('parseAnalysis: 非法输入返回 null（不抛异常）', () => {
  assert.strictEqual(parseAnalysis(''), null);
  assert.strictEqual(parseAnalysis('not a json at all'), null);
  assert.strictEqual(parseAnalysis(null), null);
});

test('checkBaseUrl: 云元数据地址一律拒绝（SSRF 黑名单）', async () => {
  await assert.rejects(() => checkBaseUrl('http://169.254.169.254/v1'), (e) => {
    assert.ok(e instanceof AiError);
    assert.strictEqual(e.retryable, false);
    return true;
  });
  await assert.rejects(() => checkBaseUrl('http://100.100.100.200/latest/meta-data'), AiError);
  // 169.254.0.0/16 全段
  await assert.rejects(() => checkBaseUrl('http://169.254.1.1/v1'), AiError);
});

test('checkBaseUrl: 内网/回环允许（本地 Ollama / vLLM 场景），非法 URL 抛错', async () => {
  assert.strictEqual(await checkBaseUrl('http://127.0.0.1:11434/v1'), null);
  assert.strictEqual(await checkBaseUrl('http://192.168.1.10:8000/v1'), null);
  await assert.rejects(() => checkBaseUrl('not-a-url'), AiError);
});
