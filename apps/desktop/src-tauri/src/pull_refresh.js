// Pull down from the top of a remote page to reload it, as in Safari. Injected
// on iOS and Android. WKWebView rubber-bands natively; this only watches the touches,
// never cancels them, and so cannot block scrolling. It stays out of the way of
// anything that scrolls or pulls on its own: inner scroll containers that are
// not at their top, form fields, canvases and maps, and elements marked
// data-no-pull-refresh.
(function () {
  if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') return;
  if (window.__ahdPullRefresh) return;
  window.__ahdPullRefresh = true;
  var TRIGGER = 80;
  var MAX = 140;
  var startY = 0;
  var startX = 0;
  var pulling = false;
  var tracking = false;
  var armed = false;
  var indicator = null;

  function scrollTopOfPage() {
    var root = document.scrollingElement || document.documentElement;
    return root ? root.scrollTop : 0;
  }
  function blocked(node) {
    for (; node && node.nodeType === 1; node = node.parentElement) {
      var tag = node.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'CANVAS' || tag === 'IFRAME' || node.isContentEditable) return true;
      if (node.hasAttribute && node.hasAttribute('data-no-pull-refresh')) return true;
      if (node === document.body || node === document.documentElement) return false;
      var style = getComputedStyle(node);
      var scrolls = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
      if (scrolls && node.scrollTop > 0) return true;
      // A tall fixed layer is a modal or drawer, not page chrome.
      if (style.position === 'fixed' && node.clientHeight > window.innerHeight / 2) return true;
    }
    return false;
  }
  function ensureIndicator() {
    if (indicator && indicator.isConnected) return indicator;
    indicator = document.createElement('div');
    indicator.id = 'ahdclient-pull-refresh';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.style.cssText = 'position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 6px);z-index:2147483645;width:34px;height:34px;margin-left:-17px;border-radius:50%;background:rgba(20,20,28,.88);color:#fff;font:700 18px/34px ui-sans-serif,system-ui,sans-serif;text-align:center;pointer-events:none;opacity:0;transform:translateY(-60px);will-change:transform,opacity;';
    indicator.textContent = '↓';
    (document.body || document.documentElement).appendChild(indicator);
    return indicator;
  }
  function show(distance) {
    var el = ensureIndicator();
    var progress = Math.min(1, distance / TRIGGER);
    el.style.transition = 'none';
    el.style.opacity = String(progress);
    el.style.transform = 'translateY(' + (distance * 0.6 - 60) + 'px) rotate(' + (progress * 180) + 'deg)';
    armed = distance >= TRIGGER;
  }
  function hide() {
    if (!indicator) return;
    indicator.style.transition = 'opacity .15s,transform .15s';
    indicator.style.opacity = '0';
    indicator.style.transform = 'translateY(-60px)';
  }
  function reset() {
    tracking = false;
    pulling = false;
    armed = false;
  }

  document.addEventListener('touchstart', function (event) {
    reset();
    if (event.touches.length !== 1 || scrollTopOfPage() > 0 || blocked(event.target)) return;
    startY = event.touches[0].clientY;
    startX = event.touches[0].clientX;
    tracking = true;
  }, { passive: true });

  document.addEventListener('touchmove', function (event) {
    if (!tracking) return;
    if (event.touches.length !== 1 || scrollTopOfPage() > 0) { reset(); hide(); return; }
    var dy = event.touches[0].clientY - startY;
    var dx = event.touches[0].clientX - startX;
    if (!pulling) {
      if (dy < -10 || Math.abs(dx) > Math.abs(dy) + 10) { reset(); return; }
      if (dy < 12) return;
      pulling = true;
    }
    show(Math.min(MAX, dy));
  }, { passive: true });

  function finish() {
    var fire = pulling && armed;
    reset();
    hide();
    if (fire) location.reload();
  }
  document.addEventListener('touchend', finish, { passive: true });
  document.addEventListener('touchcancel', function () { reset(); hide(); }, { passive: true });
})();
