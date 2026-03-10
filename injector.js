/**
 * SCH PDF Easy Downloader - Injector (MAIN world)
 *
 * 두 가지 페이지 타입을 지원합니다:
 *   1. coursebuilder (강의콘텐츠, external_tools/1)
 *      → React Hooks + Redux Store 탐색
 *      → commons_content PDF, type=text 페이지 첨부 PDF 추출
 *
 *   2. courseresource (강의자료실, external_tools/2)
 *      → Redux 없음, DOM에서 직접 .xn-resource-item 탐색
 *      → .xnri-description.pdf + thumbnail img src에서 content_id 추출
 */

(function () {
  'use strict';

  document.addEventListener('__SPE_SCAN_REQUEST', function () {
    performScan();
  });

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
          var pdfs = extractFromRedux(sections);
          sendResult({ success: true, pdfs: pdfs });
          return;
        } catch (e) {
          // Redux 파싱 실패 시 DOM 스캔으로 폴백
        }
      }
    }

    // ── 방법 B: DOM 스캔 (courseresource / 강의자료실) ──
    var domPdfs = extractFromCourseResource(iframeDoc);
    if (domPdfs.length > 0) {
      sendResult({ success: true, pdfs: domPdfs });
      return;
    }

    sendResult({ success: false, error: 'PDF를 찾을 수 없습니다. (페이지 로딩 중이거나 PDF 자료 없음)' });
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
  // Redux 기반 PDF 추출 (강의콘텐츠)
  // ────────────────────────────────────────────────────────

  function extractFromRedux(sections) {
    var pdfs = [];

    sections.forEach(function (section) {
      var subsections = section.subsections || section.sub_sections || [];
      subsections.forEach(function (sub) {
        var units = sub.units || [];
        units.forEach(function (unit) {
          var components = unit.components || unit.component_list || [];
          components.forEach(function (comp) {

            // ── 1. commons_content PDF (LTI 동영상/PDF 플레이어) ──
            if (comp.commons_content && comp.commons_content.content_type === 'pdf') {
              pdfs.push({
                title: comp.title || comp.commons_content.content_name || 'PDF',
                contentId: comp.commons_content.content_id,
                section: section.title,
                subsection: sub.title,
                type: 'commons',
              });
              return;
            }

            // ── 2. type=text (Canvas 페이지) + description에 PDF 첨부 ──
            // 교수가 페이지에 파일을 첨부한 경우 description HTML 안에 다운로드 링크 존재
            // 예: <a class="description_file_attachment" href="/courses/49563/files/2926728/download?download_frd=1">
            if (comp.type === 'text' && comp.description) {
              try {
                var parser = new DOMParser();
                var doc = parser.parseFromString(comp.description, 'text/html');
                var links = doc.querySelectorAll('a.description_file_attachment');
                links.forEach(function (link) {
                  var fnameEl = link.querySelector('.description_file_name');
                  var fname = fnameEl ? fnameEl.textContent.trim() : (link.textContent.trim());
                  var href = link.getAttribute('href');
                  if (fname.toLowerCase().endsWith('.pdf') && href) {
                    pdfs.push({
                      title: comp.title || fname.replace(/\.pdf$/i, ''),
                      contentId: 'cp_' + (comp.component_id || comp.assignment_id || Date.now()),
                      section: section.title,
                      subsection: sub.title,
                      type: 'canvas_file',
                      directUrl: href, // 상대 URL: /courses/.../files/.../download?download_frd=1
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
              if (fname.toLowerCase().endsWith('.pdf')) {
                pdfs.push({
                  title: comp.title || fname.replace(/\.pdf$/i, ''),
                  contentId: 'file_' + (comp.id || fileObj.file_id || fileObj.id || Date.now()),
                  section: section.title,
                  subsection: sub.title,
                  type: 'canvas_file',
                  directUrl: fileObj.download_url || fileObj.url || null,
                });
              }
            }
          });
        });
      });
    });

    return pdfs;
  }

  // ────────────────────────────────────────────────────────
  // DOM 기반 PDF 추출 (강의자료실 / courseresource)
  //
  // 구조:
  //   .xn-resource-item[aria-label="제목"]
  //     .xnri-description.pdf   ← PDF 타입 확인
  //     .xnri-thumbnail-commons[src="...CommonsCore2/v2/contents/{uuid}.jpg"]
  // ────────────────────────────────────────────────────────

  function extractFromCourseResource(iframeDoc) {
    var pdfs = [];
    var items = iframeDoc.querySelectorAll('.xn-resource-item');

    items.forEach(function (item) {
      // PDF 타입인지 확인
      var descEl = item.querySelector('.xnri-description.pdf');
      if (!descEl) return;

      var title = item.getAttribute('aria-label') || '';

      // thumbnail src에서 content_id 추출
      // URL 패턴: .../CommonsCore2/v2/contents/{uuid}.jpg  또는  .../contents/{hex_id}.jpg
      var img = item.querySelector('.xnri-thumbnail-commons, img[src*="contents/"]');
      if (!img) return;

      var match = img.src.match(/contents\/([^.?/]+)/);
      if (!match) return;

      var contentId = match[1];

      pdfs.push({
        title: title,
        contentId: contentId,
        section: '강의자료실',
        subsection: '',
        type: 'commons',
      });
    });

    return pdfs;
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
