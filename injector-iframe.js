/**
 * SCH PDF Easy - Frame Patcher (MAIN world, document_start, all_frames: true)
 *
 * 모든 프레임(parent + LX 앱 iframe)에서 document_start에 실행됩니다.
 *
 * [목적]
 * LX 앱 iframe의 React 앱이 초기화되기 전(componentDidMount 등 이전)에
 * fetch/XHR를 패치하여 /learningx/api/v1/courses/*/resources* 응답을 캡처합니다.
 *
 * [데이터 공유]
 * window.__SPE_LX_CACHE 와 window.__SPE_INTERCEPTED_URLS 에 저장.
 * Parent frame의 injector.js가 iframe.contentWindow.__SPE_LX_CACHE 로 접근합니다.
 */
(function () {
  'use strict';

  if (window.__SPE_FRAME_PATCHED) return;
  window.__SPE_FRAME_PATCHED = true;

  window.__SPE_LX_CACHE = { courseId: null, resources: null };
  window.__SPE_INTERCEPTED_URLS = [];

  function isLxResourcesUrl(url) {
    return url.indexOf('/learningx/api/v1/courses/') !== -1 &&
           url.indexOf('/resources') !== -1 &&
           url.indexOf('/progress') === -1;
  }

  function handleLxData(url, data) {
    var arr = Array.isArray(data) ? data : (data.resources || data.items || data.data || null);
    if (!arr || !arr.length) return;
    window.__SPE_LX_CACHE.resources = arr;
    var m = url.match(/\/courses\/(\d+)\/resources/);
    if (m) window.__SPE_LX_CACHE.courseId = m[1];
  }

  function trackUrl(url) {
    if (url.indexOf('/learningx/api/') === -1) return;
    var b = url.split('?')[0];
    if (window.__SPE_INTERCEPTED_URLS.indexOf(b) === -1) window.__SPE_INTERCEPTED_URLS.push(b);
  }

  // ── fetch 패치 ──────────────────────────────────────────────
  if (window.fetch && !window.__SPE_FETCH_PATCHED) {
    window.__SPE_FETCH_PATCHED = true;
    var origFetch = window.fetch;
    window.__SPE_FETCH_ORIG = origFetch;
    window.fetch = function (input) {
      var url = (typeof input === 'string' ? input : (input && input.url) || '').toString();
      var p = origFetch.apply(window, arguments);
      trackUrl(url);
      if (isLxResourcesUrl(url)) {
        p.then(function (r) {
          r.clone().json().then(function (d) { handleLxData(url, d); }).catch(function () {});
        }).catch(function () {});
      }
      return p;
    };
  }

  // ── XHR 패치 ────────────────────────────────────────────────
  if (window.XMLHttpRequest && !window.__SPE_XHR_PATCHED) {
    window.__SPE_XHR_PATCHED = true;
    var oOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      this._speUrl = (url || '').toString();
      return oOpen.apply(this, arguments);
    };
    var oSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.send = function () {
      var url = this._speUrl || '';
      trackUrl(url);
      if (isLxResourcesUrl(url)) {
        this.addEventListener('load', function () {
          try { handleLxData(url, JSON.parse(this.responseText)); } catch (e) {}
        });
      }
      return oSend.apply(this, arguments);
    };
  }
})();
