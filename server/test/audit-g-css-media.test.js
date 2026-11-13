'use strict';
// ============================================================
// G2（SEC-08）：sanitizeCss 嵌套 at-rule 绕过 corpus。
// 旧版按 '}' 切块、对 @media/@keyframes 整体放行，内层声明未逐条校验 ⇒
// javascript:/data: 值与 behavior/binding 属性在 @media 内原样存活。
// 修复（递归括号匹配）后内层走同一套逐条校验。本 corpus 锁定绕过面防回归。
// 威胁模型：admin 写 custom_css 投放公开主题页（非匿名），防恶意管理员 XSS 访客。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeCss } = require('../src/validate');

const DANGER = /behavior|binding|javascript:|vbscript:|expression\s*\(|url\(|@import|data:\s*(?!image\/)/i;

test('G2 @media 内危险值/属性不得存活（corpus 负向）', () => {
  const corpus = [
    '@media screen { body { behavior: url(x.htc); } }',
    '@media screen { body { -moz-binding: url(x.xml#e); } }',
    '@media screen { body { background: javascript:alert(1); } }',
    '@media screen { body { background: vbscript:msgbox(1); } }',
    '@media screen { body { background: data:text/html,<script>alert(1)</script>; } }',
    '@media screen { body { width: expression(alert(1)); } }',
    '@media screen { @import url(http://evil/x.css); }',
  ];
  for (const css of corpus) {
    const out = sanitizeCss(css);
    assert.ok(!DANGER.test(out), `危险构造须被清除：${css} => ${out}`);
  }
});

test('G2 @keyframes / @supports / 多层嵌套内危险值不得存活', () => {
  const corpus = [
    '@keyframes x { from { background: javascript:alert(1); } }',
    '@-webkit-keyframes x { to { behavior: url(x); } }',
    '@supports (display:grid) { a { color: javascript:alert(1); } }',
    '@media screen { @media (min-width:1px) { a { background: data:text/html,x; } } }',
    '@media screen { @supports (display:grid) { a { -moz-binding: url(x); } } }',
  ];
  for (const css of corpus) {
    const out = sanitizeCss(css);
    assert.ok(!DANGER.test(out), `嵌套危险构造须被清除：${css} => ${out}`);
  }
});

test('G2 引号串内花括号不致误配（content:"}" smuggling）', () => {
  const out = sanitizeCss('a { content: "}"; background: javascript:alert(1); }');
  assert.ok(!/javascript:/i.test(out), 'javascript: 值须被清除');
  assert.ok(out.includes('content'), '合法 content 声明应保留');
});

test('G2 合法嵌套样式回归保留（修复不得误杀）', () => {
  const media = '@media (max-width:600px){.card{padding:4px;color:red}}';
  const mo = sanitizeCss(media);
  assert.ok(mo.includes('@media'), '@media 应保留');
  assert.ok(mo.includes('padding:4px') && mo.includes('color:red'), '内层合法声明应保留');

  const kf = '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
  const ko = sanitizeCss(kf);
  assert.ok(ko.includes('@keyframes') && ko.includes('rotate(360deg)'), '@keyframes 合法内层应保留');

  const sup = '@supports (display:grid){.grid{display:grid}}';
  assert.ok(sanitizeCss(sup).includes('display:grid'), '@supports 合法内层应保留');
});

test('G2 普通块输出字节级不变（兼容旧行为）', () => {
  const css = 'body{background:#0b0f17} .card{border-radius:16px;box-shadow:none}';
  assert.strictEqual(sanitizeCss(css), css);
});

test('G2 病态深层嵌套不栈溢出（深度上限安全降级）', () => {
  let css = 'a{color:red}';
  for (let i = 0; i < 5000; i++) css = '@media screen{' + css + '}';
  const out = sanitizeCss(css);
  assert.ok(out.length <= 20000, '输出受 CSS_MAX 约束');
});