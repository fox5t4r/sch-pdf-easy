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
 *      → 필요 정보: lxCourseId, userId(학번), resourceId, contentId
 */

(function () {
  'use strict';

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
    var domFiles = extractFromCourseResource(iframeDoc);
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
  // DOM 기반 파일 추출 (강의자료실 / courseresource)
  // ────────────────────────────────────────────────────────

  function extractFromCourseResource(iframeDoc) {
    var files = [];
    var lxCtx = getLxContext(iframeDoc);
    console.log('[SCH PDF Easy] LX context:', JSON.stringify(lxCtx));

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

      var resourceId = getResourceId(item);

      // 진단: attrs를 문자열로 출력하여 콘솔에서 바로 확인
      console.log('[SCH PDF Easy] item[' + idx + ']:', {
        title: title,
        contentId: contentId,
        resourceId: resourceId,
        attrs: Array.from(item.attributes).map(function (a) { return a.name + '=' + a.value; }).join(' | '),
        imgSrc: img.src,
      });

      files.push({
        title: title,
        contentId: contentId,
        section: '강의자료실',
        subsection: '',
        type: 'lx_resource',
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
  //
  // 확인된 사실 (콘솔 로그 기준):
  //   - iframe URL에 파라미터 없음 (POST LTI launch)
  //   - window.ENV.course_id (소문자) = Canvas 과목 ID
  //   - window.ENV.LTI_LAUNCH_RESOURCE_URL = LTI URL → LX course_id 포함 가능
  //   - window.ENV.current_user.login_id = 학번 (userId로 사용)
  //   - window.ENV.current_user_id = Canvas 내부 ID (폴백)
  // ────────────────────────────────────────────────────────

  function getLxContext(iframeDoc) {
    var courseId = null;
    var userId = null;

    // 1. iframe URL 파라미터 (POST LTI면 보통 없음)
    try {
      var win = iframeDoc.defaultView;
      var search = new URLSearchParams(win.location.search);
      courseId = search.get('course_id') || search.get('custom_canvas_course_id') || search.get('context_id');
      userId   = search.get('user_id') || search.get('ext_user_username') || search.get('lis_person_sourcedid');
      console.log('[SCH PDF Easy] iframe URL:', win.location.href);

      // iframe 전역변수
      if (!courseId) courseId = win.COURSE_ID    != null ? String(win.COURSE_ID)    : null;
      if (!userId)   userId   = win.userLoginId  != null ? String(win.userLoginId)  : null;

      // iframe localStorage
      if (!courseId) courseId = win.localStorage.getItem('course_id') || win.localStorage.getItem('courseId');
      if (!userId)   userId   = win.localStorage.getItem('userLoginId') || win.localStorage.getItem('user_login') || win.localStorage.getItem('user_id');
    } catch (e) {
      console.warn('[SCH PDF Easy] iframe 접근 실패:', e.message);
    }

    // 2. 메인 Canvas 페이지 window.ENV (MAIN world에서 직접 접근 가능)
    try {
      var env = window.ENV;
      if (env) {
        // userId: 학번(login_id) 우선 — current_user_id는 Canvas 내부 ID라 LX API에서 불일치
        if (!userId) {
          if (env.current_user && env.current_user.login_id) {
            userId = String(env.current_user.login_id);
          } else if (env.current_user_id != null) {
            userId = String(env.current_user_id);
          }
        }

        // courseId: LTI_LAUNCH_RESOURCE_URL 파싱 → LX 전용 course_id 포함 가능성 높음
        if (!courseId && env.LTI_LAUNCH_RESOURCE_URL) {
          console.log('[SCH PDF Easy] LTI_LAUNCH_RESOURCE_URL:', env.LTI_LAUNCH_RESOURCE_URL);
          try {
            var ltiUrl = new URL(env.LTI_LAUNCH_RESOURCE_URL);
            courseId = ltiUrl.searchParams.get('course_id') ||
                       ltiUrl.searchParams.get('custom_canvas_course_id') ||
                       ltiUrl.searchParams.get('context_id');
          } catch (e2) { /* URL 파싱 실패 무시 */ }
        }

        // courseId: window.ENV.course_id (소문자!) — Canvas 과목 ID
        if (!courseId && env.course_id != null) courseId = String(env.course_id);
      }
    } catch (e) { /* 무시 */ }

    // 3. React 15 root component state 탐색 (LX course_id가 React 상태에 저장된 경우)
    if (!courseId || !userId) {
      try {
        var lxRoot = iframeDoc.getElementById('root');
        if (lxRoot) {
          var rk = Object.keys(lxRoot).find(function (k) { return k.startsWith('__reactInternalInstance'); });
          if (rk) {
            var found = searchReactState(lxRoot[rk], 0);
            console.log('[SCH PDF Easy] React root state:', JSON.stringify(found));
            if (!courseId && found.courseId) courseId = found.courseId;
            if (!userId   && found.userId)   userId   = found.userId;
          }
        }
      } catch (e) {
        console.warn('[SCH PDF Easy] React state 탐색 실패:', e.message);
      }
    }

    return { courseId: courseId, userId: userId };
  }

  // React 15 컴포넌트 트리에서 courseId/userId 탐색
  function searchReactState(inst, depth) {
    if (!inst || depth > 25) return {};
    var result = {};

    var comp = inst._instance;
    if (comp) {
      var s = comp.state || {};
      var p = comp.props  || {};

      var cidKeys = ['course_id', 'courseId', 'lx_course_id', 'learningxCourseId', 'xnCourseId'];
      for (var i = 0; i < cidKeys.length; i++) {
        var cv = s[cidKeys[i]] != null ? s[cidKeys[i]] : p[cidKeys[i]];
        if (cv != null && /^\d+$/.test(String(cv))) { result.courseId = String(cv); break; }
      }

      // 학번 패턴: 8자리 숫자
      var uidKeys = ['user_login', 'userLogin', 'login_id', 'loginId', 'student_id', 'user_id'];
      for (var j = 0; j < uidKeys.length; j++) {
        var uv = s[uidKeys[j]] != null ? s[uidKeys[j]] : p[uidKeys[j]];
        if (uv != null && /^\d{7,}$/.test(String(uv))) { result.userId = String(uv); break; }
      }

      if (result.courseId && result.userId) return result;
    }

    // _renderedComponent 재귀 탐색
    var rendered = inst._renderedComponent;
    if (rendered) {
      var sub = searchReactState(rendered, depth + 1);
      if (!result.courseId && sub.courseId) result.courseId = sub.courseId;
      if (!result.userId   && sub.userId)   result.userId   = sub.userId;
    }

    return result;
  }

  // ────────────────────────────────────────────────────────
  // resourceId 추출 (.xn-resource-item 기준)
  //
  // 확인된 사실: attrs 4개, links 없음 → data 속성/링크에 없음
  // React 15 internal instance 탐색이 핵심
  // ────────────────────────────────────────────────────────

  function getResourceId(item) {
    // 1. data 속성
    var dataId = item.getAttribute('data-id') ||
                 item.getAttribute('data-resource-id') ||
                 item.getAttribute('data-xnid');
    if (dataId && /^\d+$/.test(dataId)) return dataId;

    // 2. id 속성 숫자 부분
    var idMatch = (item.id || '').match(/(\d{4,})/);
    if (idMatch) return idMatch[1];

    // 3. React 15 internal instance 탐색
    var reactKey = Object.keys(item).find(function (k) { return k.startsWith('__reactInternalInstance'); });
    if (reactKey) {
      try {
        var inst = item[reactKey];

        // _currentElement.props 확인 (React 15 엘리먼트 레벨)
        if (inst._currentElement && inst._currentElement.props) {
          var elProps = inst._currentElement.props;
          console.log('[SCH PDF Easy] _currentElement.props keys:', Object.keys(elProps || {}).join(', '));
          var r1 = extractIdFromObj(elProps);
          if (r1) return r1;
        }

        // _instance.props / state 확인 (컴포넌트 레벨)
        if (inst._instance) {
          console.log('[SCH PDF Easy] component.props keys:', Object.keys(inst._instance.props || {}).join(', '));
          console.log('[SCH PDF Easy] component.state keys:', Object.keys(inst._instance.state || {}).join(', '));
          var r2 = extractIdFromObj(inst._instance.props) || extractIdFromObj(inst._instance.state);
          if (r2) return r2;
        }

        // _renderedComponent 재귀 탐색
        var r3 = searchReactForId(inst._renderedComponent, 0);
        if (r3) return r3;
      } catch (e) {
        console.warn('[SCH PDF Easy] React instance 접근 실패:', e.message);
      }
    }

    // 4. 내부 링크/onclick에서 resource ID 패턴
    var els = item.querySelectorAll('[href],[onclick],[data-url]');
    for (var i = 0; i < els.length; i++) {
      var str = els[i].getAttribute('href') || els[i].getAttribute('onclick') || els[i].getAttribute('data-url') || '';
      var m = str.match(/\/resources\/(\d+)/) || str.match(/resource_id[=:\s]+(\d+)/i);
      if (m) return m[1];
    }

    return null;
  }

  // React 15 렌더링 트리에서 resource ID 탐색
  function searchReactForId(inst, depth) {
    if (!inst || depth > 15) return null;

    // _currentElement.props
    if (inst._currentElement && inst._currentElement.props) {
      var r = extractIdFromObj(inst._currentElement.props);
      if (r) return r;
    }

    // _instance (class component)
    if (inst._instance) {
      var r2 = extractIdFromObj(inst._instance.props) || extractIdFromObj(inst._instance.state);
      if (r2) return r2;
    }

    // _renderedComponent (단일 자식)
    if (inst._renderedComponent) {
      var r3 = searchReactForId(inst._renderedComponent, depth + 1);
      if (r3) return r3;
    }

    // _renderedChildren (여러 자식 — DOM host 엘리먼트)
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

  // props/state 객체에서 숫자 resource ID 탐색
  function extractIdFromObj(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var directKeys = ['resource_id', 'resourceId', 'xnid', 'xn_id'];
    for (var i = 0; i < directKeys.length; i++) {
      var v = obj[directKeys[i]];
      if (v != null && /^\d+$/.test(String(v))) return String(v);
    }
    // 'id'는 마지막에 (컴포넌트 자체 ID와 혼동 방지, 4자리 이상만)
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
