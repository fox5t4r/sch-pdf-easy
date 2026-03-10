/**
 * SCH PDF Easy Downloader - Injector (MAIN world)
 *
 * 두 가지 페이지 타입을 지원합니다:
 *   1. coursebuilder (강의콘텐츠, external_tools/1)
 *      → React Hooks + Redux Store 탐색
 *      → commons_content PDF/PPT, type=text 페이지 첨부 파일 추출
 *
 *   2. courseresource (강의자료실, external_tools/2)
 *      → DOM에서 .xn-resource-item 탐색
 *      → LX API 직접 호출로 리소스 목록 취득 → resourceId 매핑
 *      → LearningX progress/force API로 다운로드
 */

(function () {
  'use strict';

  var _idCounter = 0;

  // ────────────────────────────────────────────────────────
  // LX API 캐시 (iframe fetch 인터셉터 + 스캔 시 직접 호출로 채움)
  // ────────────────────────────────────────────────────────

  var _lxCache = { courseId: null, resources: null };

  // iframe fetch 인터셉터 — LX 앱이 resources API 호출 시 데이터 캡처
  (function initFetchPatch() {
    function patch(win) {
      if (!win || !win.fetch || win.__SPE_PATCHED) return;
      win.__SPE_PATCHED = true;
      var orig = win.fetch;
      win.fetch = function (input) {
        var url = (typeof input === 'string' ? input : (input && input.url) || '').toString();
        var promise = orig.apply(win, arguments);
        if (url.indexOf('/learningx/api/v1/courses/') !== -1 &&
            url.indexOf('/resources') !== -1 &&
            url.indexOf('/progress') === -1) {
          var m = url.match(/\/courses\/(\d+)\/resources/);
          promise.then(function (resp) {
            resp.clone().json().then(function (data) {
              var arr = Array.isArray(data) ? data :
                        (data.resources || data.items || data.data || null);
              if (arr && arr.length > 0) {
                _lxCache.resources = arr;
                if (m) _lxCache.courseId = m[1];
                console.log('[SCH PDF Easy] LX resources 인터셉트:', _lxCache.courseId, arr.length + '개. 키:', Object.keys(arr[0]).join(', '));
              }
            }).catch(function () {});
          }).catch(function () {});
        }
        return promise;
      };
    }

    function tryPatch() {
      var iframe = document.getElementById('tool_content');
      if (!iframe) return;
      try { patch(iframe.contentWindow); } catch (e) {}
      iframe.addEventListener('load', function () {
        try { patch(iframe.contentWindow); } catch (e) {}
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
  // Canvas API로 login_id(학번) 조회
  // ────────────────────────────────────────────────────────

  async function fetchCanvasLoginId() {
    if (_lxCache.loginId) return _lxCache.loginId;
    try {
      var resp = await fetch('/api/v1/users/self', { credentials: 'include' });
      if (!resp.ok) return null;
      var data = await resp.json();
      console.log('[SCH PDF Easy] Canvas /users/self:', JSON.stringify({
        id: data.id, login_id: data.login_id, sis_user_id: data.sis_user_id,
      }));
      var id = data.login_id || data.sis_user_id || null;
      if (id) _lxCache.loginId = String(id);
      return _lxCache.loginId || null;
    } catch (e) {
      console.warn('[SCH PDF Easy] Canvas users/self 실패:', e.message);
      return null;
    }
  }

  // ────────────────────────────────────────────────────────
  // LX API 직접 호출 (리소스 목록 취득)
  // ────────────────────────────────────────────────────────

  async function fetchLxResources(courseId) {
    try {
      var url = '/learningx/api/v1/courses/' + courseId + '/resources';
      var resp = await fetch(url, { credentials: 'include' });
      console.log('[SCH PDF Easy] LX resources fetch:', resp.status, url);
      if (!resp.ok) return;
      var data = await resp.json();
      var arr = Array.isArray(data) ? data : (data.resources || data.items || data.data || null);
      if (arr && arr.length > 0) {
        _lxCache.resources = arr;
        _lxCache.courseId = courseId;
        console.log('[SCH PDF Easy] LX resources:', arr.length + '개. 키:', Object.keys(arr[0]).join(', '));
        console.log('[SCH PDF Easy] LX resource[0] 샘플:', JSON.stringify(arr[0]).slice(0, 300));
      } else {
        console.log('[SCH PDF Easy] LX resources 응답 비어 있음:', JSON.stringify(data).slice(0, 200));
      }
    } catch (e) {
      console.warn('[SCH PDF Easy] LX fetch 실패:', e.message);
    }
  }

  // ────────────────────────────────────────────────────────
  // DOM 기반 파일 추출 (강의자료실 / courseresource)
  // ────────────────────────────────────────────────────────

  async function extractFromCourseResource(iframeDoc) {
    var files = [];
    var lxCtx = getLxContext(iframeDoc);
    console.log('[SCH PDF Easy] LX context:', JSON.stringify(lxCtx));

    // login_id(학번) 조회 — window.ENV에 없는 경우 Canvas API로 보완
    if (!lxCtx.userId || !/^\d{7,}$/.test(lxCtx.userId)) {
      var canvasLoginId = await fetchCanvasLoginId();
      if (canvasLoginId) lxCtx.userId = canvasLoginId;
    }

    // 인터셉트로 캡처 못 했으면 직접 호출
    if (!_lxCache.resources && lxCtx.courseId) {
      await fetchLxResources(lxCtx.courseId);
    }

    var effectiveCourseId = _lxCache.courseId || lxCtx.courseId;
    console.log('[SCH PDF Easy] effectiveCourseId:', effectiveCourseId, '/ resources:', _lxCache.resources ? _lxCache.resources.length + '개' : 'null');

    var items = iframeDoc.querySelectorAll('.xn-resource-item');
    console.log('[SCH PDF Easy] 강의자료실 items 수:', items.length);

    items.forEach(function (item, idx) {
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
      var resourceId = (cachedRes ? String(cachedRes.resource_id || '') : '') || getResourceIdFromDom(item);

      // commons_content.content_id = LX API가 실제로 쓰는 content_id (UUID와 다를 수 있음)
      var lxContentId = null;
      if (cachedRes && cachedRes.commons_content) {
        var cc = cachedRes.commons_content;
        lxContentId = cc.content_id || cc.xn_id || cc.xnid || null;
        console.log('[SCH PDF Easy] commons_content:', JSON.stringify(cc).slice(0, 300));
      }

      console.log('[SCH PDF Easy] item[' + idx + ']:', {
        title: title,
        contentId: contentId,
        lxContentId: lxContentId,
        resourceId: resourceId,
      });

      files.push({
        title: title,
        contentId: contentId,
        lxContentId: lxContentId,
        section: '강의자료실',
        subsection: '',
        type: 'lx_resource',
        ext: ext,
        lxCourseId: effectiveCourseId,
        userId: lxCtx.userId,
        resourceId: resourceId,
      });
    });

    return files;
  }

  // ────────────────────────────────────────────────────────
  // LearningX 컨텍스트 추출 (courseId, userId)
  // ────────────────────────────────────────────────────────

  function getLxContext(iframeDoc) {
    var courseId = null;
    var userId = null;

    // 1. iframe URL 파라미터
    try {
      var win = iframeDoc.defaultView;
      var search = new URLSearchParams(win.location.search);
      courseId = search.get('course_id') || search.get('custom_canvas_course_id') || search.get('context_id');
      userId   = search.get('user_id') || search.get('ext_user_username') || search.get('lis_person_sourcedid');
      if (!courseId) courseId = win.COURSE_ID   != null ? String(win.COURSE_ID)   : null;
      if (!userId)   userId   = win.userLoginId != null ? String(win.userLoginId) : null;
      if (!courseId) courseId = win.localStorage.getItem('course_id') || win.localStorage.getItem('courseId');
      if (!userId)   userId   = win.localStorage.getItem('userLoginId') || win.localStorage.getItem('user_login');
    } catch (e) { }

    // 2. window.ENV (MAIN world)
    try {
      var env = window.ENV;
      if (env) {
        var cu = env.current_user || {};
        // 로그: current_user 필드 확인용
        console.log('[SCH PDF Easy] current_user 필드:', JSON.stringify({
          id: cu.id, login_id: cu.login_id, sis_user_id: cu.sis_user_id,
          pseudonym_login: cu.pseudonym_login, current_user_id: env.current_user_id,
        }));
        if (!userId) {
          // login_id = 학번 (8자리), 없으면 sis_user_id, 없으면 Canvas 내부 ID
          userId = cu.login_id || cu.sis_user_id || cu.pseudonym_login ||
                   (env.current_user_id != null ? String(env.current_user_id) : null);
        }
        if (!courseId && env.course_id != null) courseId = String(env.course_id);
      }
    } catch (e) { }

    return { courseId: courseId, userId: userId };
  }

  // ────────────────────────────────────────────────────────
  // resourceId 탐색
  // ────────────────────────────────────────────────────────

  // LX API 캐시에서 contentId/title로 매칭된 리소스 객체 반환
  function findCachedResource(contentId, title) {
    var resources = _lxCache.resources;
    if (!resources) return null;

    // contentId 기준 (다양한 필드명 시도)
    var idFields = ['xn_id', 'content_id', 'xnid', 'uuid', 'commons_content_id', 'commons_id', 'key'];
    for (var i = 0; i < resources.length; i++) {
      var r = resources[i];
      for (var k = 0; k < idFields.length; k++) {
        if (r[idFields[k]] === contentId) {
          console.log('[SCH PDF Easy] resourceId 캐시 매핑 (' + idFields[k] + '):', r.resource_id);
          return r;
        }
      }
    }

    // title 기준 폴백
    for (var j = 0; j < resources.length; j++) {
      if (resources[j].title === title || resources[j].name === title) {
        console.log('[SCH PDF Easy] resourceId 타이틀 매핑:', resources[j].resource_id);
        return resources[j];
      }
    }

    return null;
  }

  // DOM / React instance에서 resourceId 추출 (폴백)
  function getResourceIdFromDom(item) {
    var dataId = item.getAttribute('data-id') ||
                 item.getAttribute('data-resource-id') ||
                 item.getAttribute('data-xnid');
    if (dataId && /^\d+$/.test(dataId)) return dataId;

    var idMatch = (item.id || '').match(/(\d{4,})/);
    if (idMatch) return idMatch[1];

    var reactKey = Object.keys(item).find(function (k) { return k.startsWith('__reactInternalInstance'); });
    if (reactKey) {
      try {
        var inst = item[reactKey];
        if (inst._currentElement && inst._currentElement.props) {
          var r1 = extractIdFromObj(inst._currentElement.props);
          if (r1) return r1;
        }
        if (inst._instance) {
          var r2 = extractIdFromObj(inst._instance.props) || extractIdFromObj(inst._instance.state);
          if (r2) return r2;
        }
        var r3 = searchReactForId(inst._renderedComponent, 0);
        if (r3) return r3;
      } catch (e) { /* 무시 */ }
    }

    var els = item.querySelectorAll('[href],[onclick],[data-url]');
    for (var i = 0; i < els.length; i++) {
      var str = els[i].getAttribute('href') || els[i].getAttribute('onclick') || els[i].getAttribute('data-url') || '';
      var m = str.match(/\/resources\/(\d+)/) || str.match(/resource_id[=:\s]+(\d+)/i);
      if (m) return m[1];
    }

    return null;
  }

  function searchReactForId(inst, depth) {
    if (!inst || depth > 15) return null;
    if (inst._currentElement && inst._currentElement.props) {
      var r = extractIdFromObj(inst._currentElement.props);
      if (r) return r;
    }
    if (inst._instance) {
      var r2 = extractIdFromObj(inst._instance.props) || extractIdFromObj(inst._instance.state);
      if (r2) return r2;
    }
    if (inst._renderedComponent) {
      var r3 = searchReactForId(inst._renderedComponent, depth + 1);
      if (r3) return r3;
    }
    if (inst._renderedChildren) {
      var children = inst._renderedChildren;
      for (var key in children) {
        if (Object.prototype.hasOwnProperty.call(children, key)) {
          var r4 = searchReactForId(children[key], depth + 1);
          if (r4) return r4;
        }
      }
    }
    return null;
  }

  function extractIdFromObj(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var directKeys = ['resource_id', 'resourceId', 'xnid', 'xn_id'];
    for (var i = 0; i < directKeys.length; i++) {
      var v = obj[directKeys[i]];
      if (v != null && /^\d+$/.test(String(v))) return String(v);
    }
    if (obj.id != null && /^\d{4,}$/.test(String(obj.id))) return String(obj.id);
    var nestedKeys = ['resource', 'item', 'data', 'file', 'content'];
    for (var j = 0; j < nestedKeys.length; j++) {
      var sub = obj[nestedKeys[j]];
      if (sub && typeof sub === 'object') {
        var r = extractIdFromObj(sub);
        if (r) return r;
      }
    }
    return null;
  }

  // ────────────────────────────────────────────────────────
  // 결과 전송
  // ────────────────────────────────────────────────────────

  function sendResult(data) {
    document.dispatchEvent(new CustomEvent('__SPE_SCAN_RESULT', { detail: data }));
  }
})();
