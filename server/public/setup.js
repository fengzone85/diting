(function () {
  var card = document.getElementById('setupCard');

  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }

  // ① 检查是否已初始化
  fetch('/api/setup/status').then(r => r.json()).then(function (s) {
    if (!s.needs_setup) {
      // 已初始化 → 显示锁定提示，引导去登录页
      card.innerHTML =
        '<div class="setup-logo">🔒</div>' +
        '<h1>已初始化</h1>' +
        '<p class="setup-sub">管理员 Token 已设置，本页面已锁定。</p>' +
        '<div class="locked">' +
        '  ✓ 首次设置向导已禁用<br>' +
        '  ✓ 重置 Token 请通过 SSH 登录服务器，运行：<br>' +
        '  <code style="display:block;margin:8px 0;padding:8px;background:var(--bg);border-radius:6px;font-size:12px">sudo bash diting.sh --reset-admin-token</code>' +
        '</div>' +
        '<a class="btn btn-primary btn-block" href="/admin.html" style="text-decoration:none;display:inline-block;">前往登录页</a>';
      return;
    }
    // 未初始化 → 显示生成向导
    card.innerHTML =
      '<div class="setup-logo">🚀</div>' +
      '<h1>首次设置</h1>' +
      '<p class="setup-sub">生成管理员 Token，请务必保存！</p>' +
      '<p class="setup-hint">⚠️ 这是<strong>管理员后台登录</strong> Token，仅用于登录本控制台，<strong>不能用于受控端</strong>配置。受控端用的是「客户端」列表里生成的客户端 Token（无 adm_ 前缀）。</p>' +
      '<button class="btn btn-primary btn-block" id="btnGen">生成管理员 Token</button>' +
      '<div id="resultBox" style="display:none;margin-top:16px">' +
      '  <div class="token-box" id="tokenDisplay"></div>' +
      '  <p class="setup-hint" style="color:var(--red);font-weight:700">⚠️ 此 Token 仅显示一次，丢失需通过 SSH 重置！</p>' +
      '  <p class="setup-hint">请立即复制保存，后续使用此 Token 登录。</p>' +
      '  <button class="btn btn-ghost btn-block" id="btnGoLogin">已保存，去登录</button>' +
      '</div>' +
      '<div class="err" id="setupErr"></div>';

    document.getElementById('btnGen').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = '生成中…';
      document.getElementById('setupErr').textContent = '';
      fetch('/api/setup/generate', { method: 'POST' }).then(r => r.json()).then(function (j) {
        if (j.token) {
          document.getElementById('tokenDisplay').textContent = j.token;
          document.getElementById('resultBox').style.display = '';
          btn.style.display = 'none';
        } else {
          document.getElementById('setupErr').textContent = j.error || '生成失败';
          btn.disabled = false;
          btn.textContent = '重新生成';
        }
      }).catch(function (e) {
        document.getElementById('setupErr').textContent = '请求失败：' + e.message;
        btn.disabled = false;
        btn.textContent = '重新生成';
      });
    });

    document.getElementById('btnGoLogin').addEventListener('click', function () {
      location.href = '/admin.html';
    });
  }).catch(function (e) {
    card.innerHTML = '<div class="setup-logo">❌</div><h1>加载失败</h1><p class="err">' + esc(e.message) + '</p>';
  });
})();
