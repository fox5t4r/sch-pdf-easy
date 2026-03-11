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

    function patchWin(win) {
      try { patchFetch(win); patchXHR(win); } catch (e) {}
    }

    function watchIframe(iframe) {
      patchWin(iframe.contentWindow);
      iframe.addEventListener('load', function () {
        patchWin(iframe.contentWindow);
      }, { once: true });
    }

    // document_start에서 실행: iframe이 DOM에 추가되는 즉시 패치
    // (document_idle 이후라면 이미 존재하므로 바로 패치)
    (function startWatching() {
      var iframe = document.getElementById('tool_content');
      if (iframe) { watchIframe(iframe); return; }
      var obs = new MutationObserver(function () {
        var f = document.getElementById('tool_content');
        if (!f) return;
        obs.disconnect();
        watchIframe(f);
      });
      obs.observe(document, { childList: true, subtree: true });
    })();
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
    // iframe의 원본 fetch 우선 사용: LX 앱의 인증 컨텍스트(쿠키/토큰)를 활용
    var iframe = document.getElementById('tool_content');
    var iwin = iframe && iframe.contentWindow;
    var fetchFn = (iwin && iwin.__SPE_FETCH_ORIG) || (iwin && iwin.fetch) || window.fetch;
    var ctx = (iwin && (iwin.__SPE_FETCH_ORIG || iwin.fetch)) ? iwin : window;

    // LX 앱은 /resources_db를 호출하는 것으로 확인됨 → 두 엔드포인트 모두 시도
    var endpoints = [
      '/learningx/api/v1/courses/' + courseId + '/resources_db',
      '/learningx/api/v1/courses/' + courseId + '/resources',
    ];
    for (var i = 0; i < endpoints.length; i++) {
      try {
        var resp = await fetchFn.call(ctx, endpoints[i], { credentials: 'include' });
        if (!resp.ok) continue;
        var data = await resp.json();
        var arr = Array.isArray(data) ? data : (data.resources || data.items || data.data || null);
        if (arr && arr.length > 0) {
          _lxCache.resources = arr;
          _lxCache.courseId = courseId;
          return;
        }
      } catch (e) { /* 무시 */ }
    }
  }

  // ────────────────────────────────────────────────────────
  // DOM 기반 파일 추출 (강의자료실 / courseresource)
  // ────────────────────────────────────────────────────────

  // 썸네일 이미지에서 UUID 추출 헬퍼
  function extractThumbnailUUID(item, thumbnailUrl) {
    // 1) React props의 thumbnail_url에서 추출
    if (thumbnailUrl) {
      var m = thumbnailUrl.match(/contents\/([^.?/]+)/);
      if (m) return m[1];
    }
    // 2) DOM의 img 요소에서 추출
    var img = item.querySelector('.xnri-thumbnail-commons, img[src*="contents/"]');
    if (img) {
      var m2 = img.src.match(/contents\/([^.?/]+)/);
      if (m2) return m2[1];
    }
    return null;
  }

  async function extractFromCourseResource(iframeDoc) {
    var files = [];
    var courseId = getLxCourseId();

    // injector-iframe.js가 iframe 내부에서 캡처한 캐시를 우선 동기화
    var iframe = document.getElementById('tool_content');
    var iwin = iframe && iframe.contentWindow;
    try {
      if (iwin && iwin.__SPE_LX_CACHE && iwin.__SPE_LX_CACHE.resources) {
        _lxCache.resources = iwin.__SPE_LX_CACHE.resources;
        _lxCache.courseId = iwin.__SPE_LX_CACHE.courseId;
      }
      if (iwin && iwin.__SPE_INTERCEPTED_URLS) {
        iwin.__SPE_INTERCEPTED_URLS.forEach(function (u) {
          if (_interceptedApiUrls.indexOf(u) === -1) _interceptedApiUrls.push(u);
        });
      }
    } catch (e) { }

    var items = iframeDoc.querySelectorAll('.xn-resource-item');
    items.forEach(function (item) {

      // ── 방법 1 (Primary): React 컴포넌트 props에서 직접 추출 ──
      //    React 15 _currentElement._owner._instance.props.resourceData
      //    React 16+ memoizedProps.resourceData
      var resourceData = extractResourceDataFromReact(item);
      if (resourceData && resourceData.commons_content) {
        var cc = resourceData.commons_content;
        var ext = getSupportedExt('file.' + (cc.content_type || ''));
        if (!ext) return; // 지원하지 않는 파일 타입

        // 다운로드 기록 호환을 위해 썸네일 UUID를 contentId로 사용
        var thumbUUID = extractThumbnailUUID(item, cc.thumbnail_url);

        files.push({
          title: resourceData.title || cc.file_name || item.getAttribute('aria-label') || '',
          contentId: thumbUUID || cc.content_id,
          lxContentId: cc.content_id,
          section: '강의자료실',
          subsection: '',
          type: 'lx_resource',
          ext: ext,
        });
        return;
      }

      // ── 방법 2 (Fallback): DOM + LX API 캐시 ──
      var descEl = item.querySelector('.xnri-description.pdf, .xnri-description.ppt, .xnri-description.pptx');
      if (!descEl) return;

      var ext2 = descEl.classList.contains('pptx') ? 'pptx' : descEl.classList.contains('ppt') ? 'ppt' : 'pdf';
      var title = item.getAttribute('aria-label') || '';

      var contentId = extractThumbnailUUID(item, null);
      if (!contentId) return;

      // API 캐시에서 먼저 시도
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
        ext: ext2,
      });
    });

    // API 캐시 폴백: 방법 1,2 모두 lxContentId를 못 얻은 항목이 있으면 API 직접 호출
    var needsApiCache = files.some(function (f) { return !f.lxContentId; });
    if (needsApiCache && !_lxCache.resources && courseId) {
      await fetchLxResources(courseId);
      // 캐시 획득 후 lxContentId 재시도
      files.forEach(function (f) {
        if (f.lxContentId) return;
        var cachedRes = findCachedResource(f.contentId, f.title);
        if (cachedRes && cachedRes.commons_content) {
          f.lxContentId = cachedRes.commons_content.content_id || null;
        }
      });
    }

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
  // React 내부 인스턴스 키 탐색 헬퍼
  // ────────────────────────────────────────────────────────

  function findReactInternalKey(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].startsWith('__reactFiber') || keys[i].startsWith('__reactInternalInstance')) {
        return keys[i];
      }
    }
    return null;
  }

  // ────────────────────────────────────────────────────────
  // React 15/16 컴포넌트 props에서 resourceData 전체 추출
  // ────────────────────────────────────────────────────────

  function extractResourceDataFromReact(itemEl) {
    var fiberKey = findReactInternalKey(itemEl);
    if (!fiberKey) return null;

    var inst = itemEl[fiberKey];

    // ── React 15: _currentElement._owner._instance.props ──
    if (inst._currentElement) {
      var owner = inst._currentElement._owner;
      for (var depth = 0; depth < 15 && owner; depth++) {
        if (owner._instance && owner._instance.props && owner._instance.props.resourceData) {
          return owner._instance.props.resourceData;
        }
        owner = (owner._currentElement && owner._currentElement._owner) || null;
      }
      return null;
    }

    // ── React 16+: memoizedProps.resourceData ──
    var fiber = inst;
    for (var d = 0; d < 25 && fiber; d++) {
      if (fiber.memoizedProps && fiber.memoizedProps.resourceData) {
        return fiber.memoizedProps.resourceData;
      }
      fiber = fiber.return;
    }
    return null;
  }

  // ────────────────────────────────────────────────────────
  // .xn-resource-item React 컴포넌트에서 commons_content.content_id 추출
  // ────────────────────────────────────────────────────────

  function extractContentIdFromItemFiber(itemEl) {
    // 방법 A: extractResourceDataFromReact로 전체 데이터 추출
    var rd = extractResourceDataFromReact(itemEl);
    if (rd && rd.commons_content && rd.commons_content.content_id) {
      return rd.commons_content.content_id;
    }

    // 방법 B: 재귀 탐색 (폴백)
    var fiberKey = findReactInternalKey(itemEl);
    if (!fiberKey) return null;

    var inst = itemEl[fiberKey];

    // React 15: _currentElement._owner chain
    if (inst._currentElement) {
      var owner = inst._currentElement._owner;
      for (var depth = 0; depth < 15 && owner; depth++) {
        if (owner._instance && owner._instance.props) {
          var found = findCommonsContentId(owner._instance.props, 0);
          if (found) return found;
        }
        owner = (owner._currentElement && owner._currentElement._owner) || null;
      }
      return null;
    }

    // React 16+: memoizedProps / return chain
    var fiber = inst;
    for (var d = 0; d < 25 && fiber; d++) {
      var found = findCommonsContentId(fiber.memoizedProps, 0) ||
                  findCommonsContentId(fiber.memoizedState, 0);
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
    // injector-iframe.js 캐시 병합
    var iframeUrl = '';
    try {
      var ifEl = document.getElementById('tool_content');
      var iwin = ifEl && ifEl.contentWindow;
      if (iwin) {
        try { iframeUrl = iwin.location.href; } catch (e) { iframeUrl = '접근 불가'; }
        if (iwin.__SPE_LX_CACHE && iwin.__SPE_LX_CACHE.resources) {
          _lxCache.resources = iwin.__SPE_LX_CACHE.resources;
          _lxCache.courseId = iwin.__SPE_LX_CACHE.courseId;
        }
        if (iwin.__SPE_INTERCEPTED_URLS) {
          iwin.__SPE_INTERCEPTED_URLS.forEach(function (u) {
            if (_interceptedApiUrls.indexOf(u) === -1) _interceptedApiUrls.push(u);
          });
        }
      }
    } catch (e) { }

    var sample = _lxCache.resources && _lxCache.resources[0];

    // 첫 번째 .xn-resource-item의 React 키 및 데이터 추출 테스트
    var itemReactKeys = '';
    var reactVersion = '알 수 없음';
    var reactExtractResult = '미테스트';
    try {
      var iframeEl2 = document.getElementById('tool_content');
      var iDoc = iframeEl2 && (iframeEl2.contentDocument || (iframeEl2.contentWindow && iframeEl2.contentWindow.document));
      var firstItem = iDoc && iDoc.querySelector('.xn-resource-item');
      if (firstItem) {
        itemReactKeys = Object.keys(firstItem).filter(function(k) { return k.startsWith('__react'); }).join(', ') || '없음';

        // React 버전 감지
        var rKey = findReactInternalKey(firstItem);
        if (rKey) {
          var rInst = firstItem[rKey];
          if (rInst._currentElement) {
            reactVersion = 'React 15 (legacy)';
          } else if (rInst.memoizedProps || rInst.return) {
            reactVersion = 'React 16+ (fiber)';
          }
        }

        // React props 추출 테스트
        var testRd = extractResourceDataFromReact(firstItem);
        if (testRd) {
          var testCc = testRd.commons_content;
          reactExtractResult = testCc
            ? '성공 (content_id: ' + testCc.content_id + ', type: ' + testCc.content_type + ')'
            : '성공 (commons_content 없음)';
        } else {
          reactExtractResult = '실패 (resourceData 없음)';
        }
      }
    } catch(e) {
      reactExtractResult = '오류: ' + e.message;
    }

    document.dispatchEvent(new CustomEvent('__SPE_DIAG_RESULT', {
      detail: {
        courseId: _lxCache.courseId,
        resourceCount: _lxCache.resources ? _lxCache.resources.length : 0,
        resourceKeys: sample ? Object.keys(sample).join(', ') : '',
        interceptedUrls: _interceptedApiUrls.join('\n'),
        iframeUrl: iframeUrl,
        itemReactKeys: itemReactKeys,
        reactVersion: reactVersion,
        reactExtractResult: reactExtractResult,
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
