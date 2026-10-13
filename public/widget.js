/*! LLM WebChat 悬浮聊天挂件
 * 用法：<script src="https://你的域名/widget.js" defer></script>
 * 可选属性：data-title="在线助手" data-color="#2563eb" data-position="right|left" data-open="true"
 */
(function () {
  if (window.__llmWebchatWidget) return; window.__llmWebchatWidget = true;
  var script = document.currentScript || (function () { var s = document.getElementsByTagName('script'); return s[s.length - 1]; })();
  var base = script.src.replace(/widget\.js(\?.*)?$/, '');
  var ds = script.dataset || {};
  var color = ds.color || '#2563eb';
  var left = ds.position === 'left';
  var side = left ? 'left' : 'right';

  var css = '' +
    '.lwc-btn{position:fixed;bottom:24px;' + side + ':24px;width:56px;height:56px;border-radius:50%;background:' + color + ';color:#fff;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2);z-index:2147483646;display:flex;align-items:center;justify-content:center;transition:transform .2s}' +
    '.lwc-btn:hover{transform:scale(1.07)}' +
    '.lwc-btn svg{width:28px;height:28px}' +
    '.lwc-panel{position:fixed;bottom:92px;' + side + ':24px;width:380px;height:600px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden;z-index:2147483647;opacity:0;transform:translateY(16px) scale(.98);pointer-events:none;transition:opacity .2s,transform .2s}' +
    '.lwc-panel.open{opacity:1;transform:none;pointer-events:auto}' +
    '.lwc-panel iframe{width:100%;height:100%;border:0}' +
    '.lwc-close{position:absolute;top:8px;' + (left ? 'right' : 'right') + ':8px;width:28px;height:28px;border:none;border-radius:50%;background:rgba(0,0,0,.06);cursor:pointer;font-size:14px;z-index:1;display:none}' +
    '@media (max-width:600px){.lwc-panel{left:0;right:0;bottom:0;width:100%;height:100%;max-height:none;border-radius:0}.lwc-panel.open~.lwc-btn{display:none}.lwc-close{display:block}}';
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  var panel = document.createElement('div'); panel.className = 'lwc-panel';
  var close = document.createElement('button'); close.className = 'lwc-close'; close.innerHTML = '✕'; close.title = '关闭';
  panel.appendChild(close);
  var btn = document.createElement('button'); btn.className = 'lwc-btn'; btn.title = ds.title || '在线助手';
  var chatIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var xIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  btn.innerHTML = chatIcon;
  document.body.appendChild(panel); document.body.appendChild(btn);

  var loaded = false, isOpen = false;
  function toggle(open) {
    isOpen = open === undefined ? !isOpen : open;
    if (isOpen && !loaded) {
      var f = document.createElement('iframe');
      f.src = base + '?embed=1'; f.title = ds.title || '在线助手'; f.allow = 'clipboard-write';
      panel.appendChild(f); loaded = true;
    }
    panel.classList.toggle('open', isOpen);
    btn.innerHTML = isOpen ? xIcon : chatIcon;
  }
  btn.onclick = function () { toggle(); };
  close.onclick = function () { toggle(false); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen) toggle(false); });
  window.LLMWebChat = { open: function () { toggle(true); }, close: function () { toggle(false); }, toggle: function () { toggle(); } };
  if (ds.open === 'true') toggle(true);
})();
