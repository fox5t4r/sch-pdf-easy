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
 *      → .xnri-description.pdf/.ppt/.pptx + thumbnail img src에서 content_id 추출
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

  // href 스킴 검증: javascript:, data: 등 위험한 스킴 차단
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
              var ext = getSupportedExt('file.' + ct); // 'pdf', 'ppt', 'pptx' 매칭
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
            // 교수가 페이지에 파일을 첨부한 경우 description HTML 안에 다운로드 링크 존재
            // 예: <a class="description_file_attachment" href="/courses/49563/files/2926728/download?download_frd=1">
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
                  // href 스킴 검증: javascript:, data: URI 등 차단
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

            // ── 3. 파일 첨부 컴포넌트 (다양한 구조) ──
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
  // 구조:
  //   .xn-resource-item[aria-label="제목"]
  //     .xnri-description.pdf / .ppt / .pptx   ← 파일 타입 확인
  //     .xnri-thumbnail-commons[src="...CommonsCore2/v2/contents/{uuid}.jpg"]
  // ────────────────────────────────────────────────────────

  function extractFromCourseResource(iframeDoc) {
    var files = [];
    var items = iframeDoc.querySelectorAll('.xn-resource-item');

    items.forEach(function (item) {
      // 지원 파일 타입인지 확인 (PDF, PPT, PPTX)
      var descEl = item.querySelector('.xnri-description.pdf, .xnri-description.ppt, .xnri-description.pptx');
      if (!descEl) return;

      // 확장자 결정
      var ext = descEl.classList.contains('pptx') ? 'pptx'
              : descEl.classList.contains('ppt')  ? 'ppt'
              : 'pdf';

      var title = item.getAttribute('aria-label') || '';

      // thumbnail src에서 content_id 추출
      // URL 패턴: .../CommonsCore2/v2/contents/{uuid}.jpg  또는  .../contents/{hex_id}.jpg
      var img = item.querySelector('.xnri-thumbnail-commons, img[src*="contents/"]');
      if (!img) return;

      var match = img.src.match(/contents\/([^.?/]+)/);
      if (!match) return;

      var contentId = match[1];

      files.push({
        title: title,
        contentId: contentId,
        section: '강의자료실',
        subsection: '',
        type: 'commons',
        ext: ext,
      });
    });

    return files;
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
