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
  // LX API 직접 호출 (리소스 목록 취득)
  // ────────────────────────────────────────────────────────

  async function fetchLxResources(courseId) {
    try {
      var resp = await fetch('/learningx/api/v1/courses/' + courseId + '/resources', { credentials: 'include' });
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

  // Canvas ENV에서 course_id 추출
  function getLxCourseId() {
    try {
      var env = window.ENV;
      if (env && env.course_id != null) return String(env.course_id);
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
    document.dispatchEvent(new CustomEvent('__SPE_DIAG_RESULT', {
      detail: {
        courseId: _lxCache.courseId,
        resourceCount: _lxCache.resources ? _lxCache.resources.length : 0,
        resourceKeys: sample ? Object.keys(sample).join(', ') : '',
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
