/**
 * SCH PDF Easy Downloader - Injector (MAIN world)
 *
 * 두 가지 페이지 타입을 지원합니다:
 *   1. coursebuilder (강의콘텐츠, external_tools/1)
 *      → React Fiber + Redux Store 탐색
 *      → commons_content PDF/PPT, type=text 페이지 첨부 파일 추출
 *
 *   2. courseresource (강의자료실, external_tools/2)
 *      → DOM .xn-resource-item 탐색
 *      → LX API 리소스 목록으로 commons_content.content_id 획득
 *      → commons content.php API로 다운로드 URL 획득
 */

(function () {
  'use strict';

  var _idCounter = 0;

  // ────────────────────────────────────────────────────────
  // LX API 캐시 (iframe fetch 인터셉터 + 직접 호출로 채움)
  // ────────────────────────────────────────────────────────

  var _lxCache = { courseId: null, resources: null };
  var _interceptedApiUrls = []; // 캡처된 LX API URL (진단용)

  // iframe fetch 인터셉터 — LX 앱이 resources API 호출 시 데이터 캡처
  (function initFetchPatch() {
    function handleLxData(url, data) {
      var arr = Array.isArray(data) ? data : (data.resources || data.items || data.data || null);
      if (!arr || arr.length === 0) return;
      _lxCache.resources = arr;
      var m = url.match(/\/courses\/(\d+)\/resources/);
      if (m) _lxCache.courseId = m[1];
    }

    function isLxResourcesUrl(url) {
      return url.indexOf('/learningx/api/v1/courses/') !== -1 &&
             url.indexOf('/resources') !== -1 &&
             url.indexOf('/progress') === -1;
    }

    function trackApiUrl(url) {
      if (url.indexOf('/learningx/api/') === -1) return;
      var base = url.split('?')[0];
      if (_interceptedApiUrls.indexOf(base) === -1) _interceptedApiUrls.push(base);
    }

    function patchFetch(win) {
      if (!win || !win.fetch || win.__SPE_FETCH_PATCHED) return;
      win.__SPE_FETCH_PATCHED = true;
      var orig = win.fetch;
      win.__SPE_FETCH_ORIG = orig; // 원본 저장 (iframe 인증 컨텍스트로 직접 호출 시 사용)
      win.fetch = function (input) {
        var url = (typeof input === 'string' ? input : (input && input.url) || '').toString();
        var promise = orig.apply(win, arguments);
        trackApiUrl(url);
        if (isLxResourcesUrl(url)) {
          promise.then(function (resp) {
            resp.clone().json().then(function (data) { handleLxData(url, data); }).catch(function () {});
          }).catch(function () {});
        }
        return promise;
      };
    }

    function patchXHR(win) {
      if (!win || !win.XMLHttpRequest || win.__SPE_XHR_PATCHED) return;
      win.__SPE_XHR_PATCHED = true;
      var origOpen = win.XMLHttpRequest.prototype.open;
      win.XMLHttpRequest.prototype.open = function (method, url) {
        this._speUrl = (url || '').toString();
        return origOpen.apply(this, arguments);
      };
      var origSend = win.XMLHttpRequest.prototype.send;
      win.XMLHttpRequest.prototype.send = function () {
        var url = this._speUrl || '';
        trackApiUrl(url);
        if (isLxResourcesUrl(url)) {
          this.addEventListener('load', function () {
            try { handleLxData(url, JSON.parse(this.responseText)); } catch (e) {}
          });
        }
        return origSend.apply(this, arguments);
      };
    }

    function tryPatch() {
      var iframe = document.getElementById('tool_content');
      if (!iframe) return;
      try { patchFetch(iframe.contentWindow); patchXHR(iframe.contentWindow); } catch (e) {}
      iframe.addEventListener('load', function () {
        try { patchFetch(iframe.contentWindow); patchXHR(iframe.contentWindow); } catch (e) {}
      }, { once: true });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryPatch);
    } else {
      tryPatch();
    }
  })();

  // ────────────────────────────────────────────────────────
  // 이벤트 수신
  // ────────────────────────────────────────────────────────

  document.addEventListener('__SPE_SCAN_REQUEST', function () {
    _idCounter = 0;
    performScan();
  });

  // ────────────────────────────────────────────────────────
  // 파일 타입 헬퍼
  // ────────────────────────────────────────────────────────

  var SUPPORTED_EXTS = ['pdf', 'ppt', 'pptx'];

  function getSupportedExt(fname) {
    var lower = (fname || '').toLowerCase();
    for (var i = 0; i < SUPPORTED_EXTS.length; i++) {
      if (lower.endsWith('.' + SUPPORTED_EXTS[i])) return SUPPORTED_EXTS[i];
    }
    return null;
  }

  function isAllowedHref(href) {
    return (
      typeof href === 'string' &&
      (href.startsWith('/') || href.startsWith('https://') || href.startsWith('http://'))
    );
  }

  function stripExt(fname, ext) {
    return fname.replace(new RegExp('\\.' + ext + '$', 'i'), '');
  }

  // ────────────────────────────────────────────────────────
  // 스캔 진입점
  // ────────────────────────────────────────────────────────

  async function performScan() {
    var iframe = document.getElementById('tool_content');
    if (!iframe) { sendResult({ success: false, error: 'iframe#tool_content을 찾을 수 없습니다.' }); return; }

    var iframeDoc;
    try {
      iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    } catch (e) {
      sendResult({ success: false, error: 'iframe 접근 불가: ' + e.message }); return;
    }
    if (!iframeDoc) { sendResult({ success: false, error: 'iframe document가 null입니다.' }); return; }

    var root = iframeDoc.getElementById('root');
    if (!root) { sendResult({ success: false, error: 'iframe 내부 #root를 찾을 수 없습니다.' }); return; }

    // ── 방법 A: Redux Store (coursebuilder / 강의콘텐츠) ──
    var fiberKey = Object.keys(root).find(function (k) {
      return k.startsWith('__reactFiber') || k.startsWith('__reactContainer');
    });
    if (fiberKey) {
      var store = findStore(root[fiberKey], 0);
      if (store) {
        try {
          var state = store.getState();
          var sections = (state.sections && state.sections.sections) || (state.section && state.section.sections) || [];
          sendResult({ success: true, pdfs: extractFromRedux(sections) });
          return;
        } catch (e) { /* Redux 파싱 실패 → DOM 스캔으로 폴백 */ }
      }
    }

    // ── 방법 B: DOM 스캔 (courseresource / 강의자료실) ──
    var domFiles = await extractFromCourseResource(iframeDoc);
    if (domFiles.length > 0) { sendResult({ success: true, pdfs: domFiles }); return; }

    sendResult({ success: false, error: 'PDF/PPT를 찾을 수 없습니다. (페이지 로딩 중이거나 자료 없음)' });
  }

  // ────────────────────────────────────────────────────────
  // Redux Store 탐색 (강의콘텐츠)
  // ────────────────────────────────────────────────────────

  function findStore(node, depth) {
    if (!node || depth > 30) return null;
    if (node.memoizedProps && node.memoizedProps.store) return node.memoizedProps.store;
    return findStore(node.child, depth + 1) || findStore(node.sibling, depth + 1);
  }

  function extractFromRedux(sections) {
    var files = [];
    sections.forEach(function (section) {
      var subsections = section.subsections || section.sub_sections || [];
      subsections.forEach(function (sub) {
        (sub.units || []).forEach(function (unit) {
          (unit.components || unit.component_list || []).forEach(function (comp) {

            if (comp.commons_content) {
              var ct = comp.commons_content.content_type;
              var ext = getSupportedExt('file.' + ct);
              if (ext) {
                files.push({ title: comp.title || comp.commons_content.content_name || ct.toUpperCase(), contentId: comp.commons_content.content_id, section: section.title, subsection: sub.title, type: 'commons', ext: ext });
                return;
              }
            }

            if (comp.type === 'text' && comp.description) {
              try {
                var doc = new DOMParser().parseFromString(comp.description, 'text/html');
                doc.querySelectorAll('a.description_file_attachment').forEach(function (link) {
                  var fnameEl = link.querySelector('.description_file_name');
                  var fname = fnameEl ? fnameEl.textContent.trim() : link.textContent.trim();
                  var href = link.getAttribute('href');
                  var ext = getSupportedExt(fname);
                  if (ext && isAllowedHref(href)) {
                    files.push({ title: comp.title || stripExt(fname, ext), contentId: 'cp_' + (comp.component_id || comp.assignment_id || ('fb' + (++_idCounter))), section: section.title, subsection: sub.title, type: 'canvas_file', ext: ext, directUrl: href });
                  }
                });
              } catch (e) { }
              return;
            }

            var fileObj = comp.attach_file || comp.file_content || comp.file_info || comp.upload_file || null;
            if (fileObj) {
              var fname = fileObj.file_name || fileObj.name || fileObj.display_name || '';
              var ext = getSupportedExt(fname);
              if (ext) {
                files.push({ title: comp.title || stripExt(fname, ext), contentId: 'file_' + (comp.id || fileObj.file_id || fileObj.id || ('fb' + (++_idCounter))), section: section.title, subsection: sub.title, type: 'canvas_file', ext: ext, directUrl: fileObj.download_url || fileObj.url || null });
              }
            }
          });
        });
      });
    });
    return files;
  }

  // ────────────────────────────────────────────────────────
  // LX API 직접 호출 (리소스 목록 취득)
  // ────────────────────────────────────────────────────────

  async function fetchLxResources(courseId) {
    // iframe의 원본 fetch 우선 사용: LX 앱의 인증 컨텍스트(LocalStorage 토큰 등)를 활용
    var iframe = document.getElementById('tool_content');
    var iwin = iframe && iframe.contentWindow;
    var fetchFn = (iwin && iwin.__SPE_FETCH_ORIG) || (iwin && iwin.fetch) || window.fetch;
    var ctx = (iwin && (iwin.__SPE_FETCH_ORIG || iwin.fetch)) ? iwin : window;
    try {
      var resp = await fetchFn.call(ctx, '/learningx/api/v1/courses/' + courseId + '/resources', { credentials: 'include' });
      if (!resp.ok) return;
      var data = await resp.json();
      var arr = Array.isArray(data) ? data : (data.resources || data.items || data.data || null);
      if (arr && arr.length > 0) {
        _lxCache.resources = arr;
        _lxCache.courseId = courseId;
      }
    } catch (e) { /* 무시 */ }
  }

  // ────────────────────────────────────────────────────────
  // DOM 기반 파일 추출 (강의자료실 / courseresource)
  // ────────────────────────────────────────────────────────

  async function extractFromCourseResource(iframeDoc) {
    var files = [];
    var courseId = getLxCourseId();

    if (!_lxCache.resources && courseId) {
      await fetchLxResources(courseId);
    }

    var items = iframeDoc.querySelectorAll('.xn-resource-item');
    items.forEach(function (item) {
      var descEl = item.querySelector('.xnri-description.pdf, .xnri-description.ppt, .xnri-description.pptx');
      if (!descEl) return;

      var ext = descEl.classList.contains('pptx') ? 'pptx' : descEl.classList.contains('ppt') ? 'ppt' : 'pdf';
      var title = item.getAttribute('aria-label') || '';

      var img = item.querySelector('.xnri-thumbnail-commons, img[src*="contents/"]');
      if (!img) return;
      var match = img.src.match(/contents\/([^.?/]+)/);
      if (!match) return;
      var contentId = match[1];

      var cachedRes = findCachedResource(contentId, title);
      var lxContentId = cachedRes && cachedRes.commons_content
        ? (cachedRes.commons_content.content_id || null)
        : null;

      // LX API 캐시 미스 시 React fiber에서 직접 추출 시도
      if (!lxContentId) {
        lxContentId = extractContentIdFromItemFiber(item);
      }

      files.push({
        title: title,
        contentId: contentId,
        lxContentId: lxContentId,
        section: '강의자료실',
        subsection: '',
        type: 'lx_resource',
        ext: ext,
      });
    });

    return files;
  }

  // Canvas ENV에서 course_id 추출 (URL fallback 포함)
  function getLxCourseId() {
    try {
      var env = window.ENV;
      if (env && env.course_id != null) return String(env.course_id);
    } catch (e) { }
    var m = window.location.pathname.match(/\/courses\/(\d+)\//);
    return m ? m[1] : null;
  }

  // ────────────────────────────────────────────────────────
  // .xn-resource-item React fiber에서 commons_content.content_id 추출
  // ────────────────────────────────────────────────────────

  function extractContentIdFromItemFiber(itemEl) {
    var fiberKey = null;
    var keys = Object.keys(itemEl);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].startsWith('__reactFiber') || keys[i].startsWith('__reactInternalInstance')) {
        fiberKey = keys[i];
        break;
      }
    }
    if (!fiberKey) return null;

    // DOM 요소 fiber에서 부모 컴포넌트 방향으로 올라가며 props 전체 탐색
    var fiber = itemEl[fiberKey];
    for (var depth = 0; depth < 25 && fiber; depth++) {
      var found = findCommonsContentId(fiber.memoizedProps, 0);
      if (found) return found;
      fiber = fiber.return;
    }
    return null;
  }

  // props 객체 전체를 재귀 탐색해 commons_content.content_id 또는 비UUID content_id 반환
  function findCommonsContentId(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    if (Array.isArray(obj)) return null;
    try {
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = obj[k];
        // commons_content.content_id 직접 탐색
        if (k === 'commons_content' && v && typeof v === 'object' && v.content_id) return v.content_id;
        // 비UUID content_id: 단축 hex(하이픈 없음, 10자 이상)
        if (k === 'content_id' && typeof v === 'string' && v.length >= 10 && v.indexOf('-') === -1) return v;
        // 재귀 (함수·배열·null 제외)
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          var r = findCommonsContentId(v, depth + 1);
          if (r) return r;
        }
      }
    } catch (e) { }
    return null;
  }

  // LX API 캐시에서 contentId/title로 매칭된 리소스 객체 반환
  function findCachedResource(contentId, title) {
    var resources = _lxCache.resources;
    if (!resources) return null;

    var idFields = ['xn_id', 'content_id', 'xnid', 'uuid', 'commons_content_id', 'commons_id', 'key'];
    for (var i = 0; i < resources.length; i++) {
      var r = resources[i];
      for (var k = 0; k < idFields.length; k++) {
        if (r[idFields[k]] === contentId) return r;
      }
    }

    for (var j = 0; j < resources.length; j++) {
      if (resources[j].title === title || resources[j].name === title) return resources[j];
    }

    return null;
  }

  // ────────────────────────────────────────────────────────
  // 진단 정보 제공
  // ────────────────────────────────────────────────────────

  document.addEventListener('__SPE_DIAG_REQUEST', function () {
    var sample = _lxCache.resources && _lxCache.resources[0];

    // 첫 번째 .xn-resource-item의 React 키 확인
    var itemReactKeys = '';
    try {
      var iframe = document.getElementById('tool_content');
      var iDoc = iframe && (iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document));
      var firstItem = iDoc && iDoc.querySelector('.xn-resource-item');
      if (firstItem) {
        itemReactKeys = Object.keys(firstItem).filter(function(k) { return k.startsWith('__react'); }).join(', ') || '없음';
      }
    } catch(e) {}

    document.dispatchEvent(new CustomEvent('__SPE_DIAG_RESULT', {
      detail: {
        courseId: _lxCache.courseId,
        resourceCount: _lxCache.resources ? _lxCache.resources.length : 0,
        resourceKeys: sample ? Object.keys(sample).join(', ') : '',
        interceptedUrls: _interceptedApiUrls.join('\n'),
        itemReactKeys: itemReactKeys,
        sample: sample ? {
          title: sample.title,
          resource_id: sample.resource_id,
          commonsContentId: sample.commons_content ? sample.commons_content.content_id : null,
          commonsProgressSupport: sample.commons_content ? sample.commons_content.progress_support : null,
        } : null,
      },
    }));
  });

  // ────────────────────────────────────────────────────────
  // 결과 전송
  // ────────────────────────────────────────────────────────

  function sendResult(data) {
    document.dispatchEvent(new CustomEvent('__SPE_SCAN_RESULT', { detail: data }));
  }
})();
