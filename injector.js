/**
 * SCH PDF Easy Downloader - Injector (MAIN world)
 *
 * 두 가지 페이지 타입을 지원합니다:
 *   1. coursebuilder (강의콘텐츠, external_tools/1)
 *      → React Hooks + Redux Store 탐색
 *      → commons_content PDF/PPT, type=text 페이지 첨부 파일 추출
 *
 *   2. courseresource (강의자료실, external_tools/2)
 *      → Redux 없음, DOM에서 직접 .xn-resource-item 탐색
 *      → LearningX API로 다운로드 (progress/force 엔드포인트)
 *      → 필요 정보: lxCourseId, userId, resourceId, contentId
 */

(function () {
  'use strict';

  // 스캔마다 초기화되는 카운터 — Date.now() 대신 결정적 fallback contentId 생성
  var _idCounter = 0;

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

  function performScan() {
    var iframe = document.getElementById('tool_content');
    if (!iframe) {
      sendResult({ success: false, error: 'iframe#tool_content을 찾을 수 없습니다.' });
      return;
    }

    var iframeDoc;
    try {
      iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    } catch (e) {
      sendResult({ success: false, error: 'iframe 접근 불가: ' + e.message });
      return;
    }

    if (!iframeDoc) {
      sendResult({ success: false, error: 'iframe document가 null입니다.' });
      return;
    }

    var root = iframeDoc.getElementById('root');
    if (!root) {
      sendResult({ success: false, error: 'iframe 내부 #root를 찾을 수 없습니다.' });
      return;
    }

    // ── 방법 A: Redux Store (coursebuilder / 강의콘텐츠) ──
    var fiberKey = Object.keys(root).find(function (k) {
      return k.startsWith('__reactFiber') || k.startsWith('__reactContainer');
    });

    if (fiberKey) {
      var store = findStore(root[fiberKey], 0);
      if (store) {
        try {
          var state = store.getState();
          var sections =
            (state.sections && state.sections.sections) ||
            (state.section && state.section.sections) ||
            [];
          var files = extractFromRedux(sections);
          sendResult({ success: true, pdfs: files });
          return;
        } catch (e) {
          // Redux 파싱 실패 시 DOM 스캔으로 폴백
        }
      }
    }

    // ── 방법 B: DOM 스캔 (courseresource / 강의자료실) ──
    var domFiles = extractFromCourseResource(iframeDoc);
    if (domFiles.length > 0) {
      sendResult({ success: true, pdfs: domFiles });
      return;
    }

    sendResult({ success: false, error: 'PDF/PPT를 찾을 수 없습니다. (페이지 로딩 중이거나 자료 없음)' });
  }

  // ────────────────────────────────────────────────────────
  // Redux Store 탐색
  // ────────────────────────────────────────────────────────

  function findStore(node, depth) {
    if (!node || depth > 30) return null;
    if (node.memoizedProps && node.memoizedProps.store) {
      return node.memoizedProps.store;
    }
    return findStore(node.child, depth + 1) || findStore(node.sibling, depth + 1);
  }

  // ────────────────────────────────────────────────────────
  // Redux 기반 파일 추출 (강의콘텐츠)
  // ────────────────────────────────────────────────────────

  function extractFromRedux(sections) {
    var files = [];

    sections.forEach(function (section) {
      var subsections = section.subsections || section.sub_sections || [];
      subsections.forEach(function (sub) {
        var units = sub.units || [];
        units.forEach(function (unit) {
          var components = unit.components || unit.component_list || [];
          components.forEach(function (comp) {

            // ── 1. commons_content (LTI 동영상/PDF/PPT 플레이어) ──
            if (comp.commons_content) {
              var ct = comp.commons_content.content_type;
              var ext = getSupportedExt('file.' + ct);
              if (ext) {
                files.push({
                  title: comp.title || comp.commons_content.content_name || ct.toUpperCase(),
                  contentId: comp.commons_content.content_id,
                  section: section.title,
                  subsection: sub.title,
                  type: 'commons',
                  ext: ext,
                });
                return;
              }
            }

            // ── 2. type=text (Canvas 페이지) + description에 파일 첨부 ──
            if (comp.type === 'text' && comp.description) {
              try {
                var parser = new DOMParser();
                var doc = parser.parseFromString(comp.description, 'text/html');
                var links = doc.querySelectorAll('a.description_file_attachment');
                links.forEach(function (link) {
                  var fnameEl = link.querySelector('.description_file_name');
                  var fname = fnameEl ? fnameEl.textContent.trim() : link.textContent.trim();
                  var href = link.getAttribute('href');
                  var ext = getSupportedExt(fname);
                  if (ext && isAllowedHref(href)) {
                    files.push({
                      title: comp.title || stripExt(fname, ext),
                      contentId: 'cp_' + (comp.component_id || comp.assignment_id || ('fb' + (++_idCounter))),
                      section: section.title,
                      subsection: sub.title,
                      type: 'canvas_file',
                      ext: ext,
                      directUrl: href,
                    });
                  }
                });
              } catch (e) { /* DOMParser 실패 무시 */ }
              return;
            }

            // ── 3. 파일 첨부 컴포넌트 ──
            var fileObj =
              comp.attach_file ||
              comp.file_content ||
              comp.file_info ||
              comp.upload_file ||
              null;

            if (fileObj) {
              var fname = fileObj.file_name || fileObj.name || fileObj.display_name || '';
              var ext = getSupportedExt(fname);
              if (ext) {
                files.push({
                  title: comp.title || stripExt(fname, ext),
                  contentId: 'file_' + (comp.id || fileObj.file_id || fileObj.id || ('fb' + (++_idCounter))),
                  section: section.title,
                  subsection: sub.title,
                  type: 'canvas_file',
                  ext: ext,
                  directUrl: fileObj.download_url || fileObj.url || null,
                });
              }
            }
          });
        });
      });
    });

    return files;
  }

  // ────────────────────────────────────────────────────────
  // DOM 기반 파일 추출 (강의자료실 / courseresource)
  //
  // 다운로드 URL 패턴 (LearningX API):
  //   /learningx/api/v1/courses/{lxCourseId}/resources/{resourceId}/progress/force
  //   ?user_id={userId}&content_id={contentId}&content_type={ext}
  //
  // 필요 정보:
  //   - lxCourseId : iframe URL 파라미터 / 전역변수 / localStorage
  //   - userId     : iframe URL 파라미터 / window.ENV / localStorage
  //   - resourceId : .xn-resource-item의 data 속성 / React 15 내부 instance / 링크 href
  //   - contentId  : thumbnail img src의 contents/{uuid}
  // ────────────────────────────────────────────────────────

  function extractFromCourseResource(iframeDoc) {
    var files = [];

    // LearningX 컨텍스트 추출 (courseId, userId)
    var lxCtx = getLxContext(iframeDoc);
    console.log('[SCH PDF Easy] LX context:', JSON.stringify(lxCtx));

    var items = iframeDoc.querySelectorAll('.xn-resource-item');
    console.log('[SCH PDF Easy] 강의자료실 items 수:', items.length);

    items.forEach(function (item, idx) {
      // 지원 파일 타입인지 확인 (PDF, PPT, PPTX)
      var descEl = item.querySelector('.xnri-description.pdf, .xnri-description.ppt, .xnri-description.pptx');
      if (!descEl) return;

      var ext = descEl.classList.contains('pptx') ? 'pptx'
              : descEl.classList.contains('ppt')  ? 'ppt'
              : 'pdf';

      var title = item.getAttribute('aria-label') || '';

      // thumbnail src에서 content_id 추출
      var img = item.querySelector('.xnri-thumbnail-commons, img[src*="contents/"]');
      if (!img) return;

      var match = img.src.match(/contents\/([^.?/]+)/);
      if (!match) return;
      var contentId = match[1];

      // resourceId 추출 (다운로드 URL 구성에 필요)
      var resourceId = getResourceId(item);

      console.log('[SCH PDF Easy] item[' + idx + ']', {
        title: title,
        contentId: contentId,
        resourceId: resourceId,
        // 진단: item의 모든 속성 출력
        attrs: Array.from(item.attributes).map(function (a) { return a.name + '=' + a.value; }),
        // 진단: item 내부 링크들
        links: Array.from(item.querySelectorAll('[href],[onclick],[data-url]')).map(function (el) {
          return { tag: el.tagName, href: el.getAttribute('href'), onclick: el.getAttribute('onclick') };
        }).slice(0, 5),
      });

      files.push({
        title: title,
        contentId: contentId,
        section: '강의자료실',
        subsection: '',
        type: 'lx_resource',   // 강의자료실 전용 타입 — content.php 대신 LX API 사용
        ext: ext,
        lxCourseId: lxCtx.courseId,
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

    try {
      var win = iframeDoc.defaultView;

      // 1. iframe URL 파라미터 (LTI launch params에 포함될 수 있음)
      var search = new URLSearchParams(win.location.search);
      courseId = search.get('course_id') ||
                 search.get('custom_canvas_course_id') ||
                 search.get('context_id');
      userId   = search.get('user_id') ||
                 search.get('custom_canvas_user_id') ||
                 search.get('ext_user_username') ||
                 search.get('lis_person_sourcedid');

      console.log('[SCH PDF Easy] iframe URL:', win.location.href);

      // 2. iframe 전역 변수
      if (!courseId) {
        courseId = win.COURSE_ID    != null ? String(win.COURSE_ID)    :
                   win.__COURSE_ID__ != null ? String(win.__COURSE_ID__) :
                   (win.ENV && win.ENV.COURSE_ID != null) ? String(win.ENV.COURSE_ID) : null;
      }
      if (!userId) {
        userId = win.USER_ID      != null ? String(win.USER_ID)      :
                 win.__USER_ID__   != null ? String(win.__USER_ID__)   :
                 win.userLoginId   != null ? String(win.userLoginId)   :
                 (win.ENV && win.ENV.current_user_id != null) ? String(win.ENV.current_user_id) : null;
      }

      // 3. localStorage / sessionStorage
      if (!courseId) {
        courseId = win.localStorage.getItem('courseId')  ||
                   win.localStorage.getItem('course_id') ||
                   win.sessionStorage.getItem('courseId') ||
                   win.sessionStorage.getItem('course_id');
      }
      if (!userId) {
        userId = win.localStorage.getItem('userId')      ||
                 win.localStorage.getItem('user_id')     ||
                 win.localStorage.getItem('userLoginId') ||
                 win.localStorage.getItem('loginId')     ||
                 win.sessionStorage.getItem('userId')    ||
                 win.sessionStorage.getItem('user_id');
      }
    } catch (e) {
      console.warn('[SCH PDF Easy] iframe 컨텍스트 접근 실패:', e.message);
    }

    // 4. 메인 Canvas 페이지 ENV (injector.js는 MAIN world → window.ENV 접근 가능)
    if (!userId || !courseId) {
      try {
        var env = window.ENV;
        if (env) {
          if (!courseId && env.COURSE_ID != null) courseId = String(env.COURSE_ID);
          if (!userId) {
            userId = env.current_user_id != null
              ? String(env.current_user_id)
              : env.CURRENT_USER && env.CURRENT_USER.login_id
                ? String(env.CURRENT_USER.login_id)
                : env.current_user && env.current_user.login_id
                  ? String(env.current_user.login_id)
                  : null;
          }
        }
        console.log('[SCH PDF Easy] window.ENV keys:', env ? Object.keys(env).join(',') : 'none');
      } catch (e) { /* 무시 */ }
    }

    return { courseId: courseId, userId: userId };
  }

  // ────────────────────────────────────────────────────────
  // resourceId 추출 (.xn-resource-item 기준)
  // ────────────────────────────────────────────────────────

  function getResourceId(item) {
    // 1. data 속성 직접 확인
    var dataId = item.getAttribute('data-id') ||
                 item.getAttribute('data-resource-id') ||
                 item.getAttribute('data-xnid') ||
                 item.getAttribute('data-content-id');
    if (dataId && /^\d+$/.test(dataId)) return dataId;

    // 2. id 속성에서 숫자 추출 (예: "resource-642419" → "642419")
    var idMatch = (item.id || '').match(/(\d{4,})/);
    if (idMatch) return idMatch[1];

    // 3. React 15 internal instance에서 props/state 탐색
    var reactKey = Object.keys(item).find(function (k) {
      return k.startsWith('__reactInternalInstance');
    });
    if (reactKey) {
      try {
        var inst = item[reactKey]._instance;
        if (inst) {
          var rid = extractIdFromObj(inst.props) || extractIdFromObj(inst.state);
          if (rid) return rid;
        }
      } catch (e) { /* 무시 */ }
    }

    // 4. 내부 링크/버튼/onclick에서 resource ID 패턴 탐색
    var els = item.querySelectorAll('[href],[onclick],[data-url]');
    for (var i = 0; i < els.length; i++) {
      var str = els[i].getAttribute('href') ||
                els[i].getAttribute('onclick') ||
                els[i].getAttribute('data-url') || '';
      var m = str.match(/\/resources\/(\d+)/) ||
              str.match(/resource_id[=:\s]+(\d+)/i) ||
              str.match(/resourceId[=:\s]+(\d+)/i);
      if (m) return m[1];
    }

    // 5. thumbnail img src에서 resource ID 패턴 탐색
    var img = item.querySelector('img');
    if (img) {
      var srcMatch = (img.getAttribute('src') || img.src || '').match(/\/resources\/(\d+)/);
      if (srcMatch) return srcMatch[1];
    }

    return null;
  }

  // props/state 객체에서 숫자 ID 재귀 탐색
  function extractIdFromObj(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var directKeys = ['resource_id', 'resourceId', 'xnid', 'xn_id'];
    for (var i = 0; i < directKeys.length; i++) {
      var v = obj[directKeys[i]];
      if (v != null && /^\d+$/.test(String(v))) return String(v);
    }
    // 'id'는 마지막에 (컴포넌트 자체 ID와 혼동 방지)
    if (obj.id != null && /^\d{4,}$/.test(String(obj.id))) return String(obj.id);

    // nested 객체 탐색: resource, item, data
    var nestedKeys = ['resource', 'item', 'data', 'file'];
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
    document.dispatchEvent(
      new CustomEvent('__SPE_SCAN_RESULT', { detail: data })
    );
  }
})();
