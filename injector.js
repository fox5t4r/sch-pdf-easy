/**
 * SCH PDF Easy Downloader - Injector (MAIN world)
 *
 * 이 스크립트는 페이지의 MAIN world에서 실행되어
 * React/Redux 내부 변수에 직접 접근합니다.
 * 추출한 PDF 목록을 CustomEvent로 content.js(ISOLATED world)에 전달합니다.
 */

(function () {
  'use strict';

  document.addEventListener('__SPE_SCAN_REQUEST', () => {
    performScan();
  });

  function performScan() {
    const iframe = document.getElementById('tool_content');
    if (!iframe) {
      sendResult({ success: false, error: 'iframe#tool_content을 찾을 수 없습니다.' });
      return;
    }

    let iframeDoc;
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

    const root = iframeDoc.getElementById('root');
    if (!root) {
      sendResult({ success: false, error: 'iframe 내부 #root 요소를 찾을 수 없습니다.' });
      return;
    }

    const fiberKey = Object.keys(root).find(
      (k) => k.startsWith('__reactFiber') || k.startsWith('__reactContainer')
    );
    if (!fiberKey) {
      sendResult({ success: false, error: 'React Fiber를 찾을 수 없습니다.' });
      return;
    }

    const store = findStore(root[fiberKey], 0);
    if (!store) {
      sendResult({ success: false, error: 'Redux Store를 찾을 수 없습니다.' });
      return;
    }

    try {
      const state = store.getState();
      const sections = state.sections?.sections || state.section?.sections || [];
      const pdfs = extractPDFs(sections);
      sendResult({ success: true, pdfs });
    } catch (e) {
      sendResult({ success: false, error: 'Redux 데이터 파싱 실패: ' + e.message });
    }
  }

  function findStore(node, depth) {
    if (!node || depth > 30) return null;
    if (node.memoizedProps && node.memoizedProps.store) {
      return node.memoizedProps.store;
    }
    return findStore(node.child, depth + 1) || findStore(node.sibling, depth + 1);
  }

  function extractPDFs(sections) {
    const pdfs = [];

    sections.forEach((section) => {
      const subsections = section.subsections || section.sub_sections || [];
      subsections.forEach((sub) => {
        const units = sub.units || [];
        units.forEach((unit) => {
          const components = unit.components || unit.component_list || [];
          components.forEach((comp) => {

            // ── 방법 1: commons_content (LTI 콘텐츠 PDF) ──
            if (comp.commons_content?.content_type === 'pdf') {
              pdfs.push({
                title: comp.title || comp.commons_content.content_name || 'PDF',
                contentId: comp.commons_content.content_id,
                section: section.title,
                subsection: sub.title,
                type: 'commons',
              });
              return;
            }

            // ── 방법 2: 파일 첨부 (직접 업로드) ──
            // 다양한 구조 탐색: attach_file, file_content, file_info 등
            const fileObj =
              comp.attach_file ||
              comp.file_content ||
              comp.file_info ||
              comp.upload_file ||
              null;

            if (fileObj) {
              const fname = fileObj.file_name || fileObj.name || fileObj.display_name || '';
              if (fname.toLowerCase().endsWith('.pdf')) {
                pdfs.push({
                  title: comp.title || fname.replace(/\.pdf$/i, ''),
                  contentId: `file_${comp.id || fileObj.file_id || fileObj.id || Date.now()}`,
                  section: section.title,
                  subsection: sub.title,
                  type: 'file',
                  directUrl: fileObj.download_url || fileObj.url || null,
                });
                return;
              }
            }

            // ── 방법 3: 컴포넌트 자체가 파일 타입 ──
            if (
              (comp.content_type === 'file' || comp.type === 'file' ||
               comp.xn_component_type === 'attach' || comp.component_type === 'file') &&
              comp.id
            ) {
              const fname = comp.file_name || comp.name || comp.original_name || comp.title || '';
              if (fname.toLowerCase().endsWith('.pdf')) {
                pdfs.push({
                  title: comp.title || fname.replace(/\.pdf$/i, ''),
                  contentId: `file_${comp.id}`,
                  section: section.title,
                  subsection: sub.title,
                  type: 'file',
                  directUrl: comp.download_url || comp.url || null,
                });
              }
            }

          });
        });
      });
    });

    return pdfs;
  }

  function sendResult(data) {
    document.dispatchEvent(
      new CustomEvent('__SPE_SCAN_RESULT', { detail: data })
    );
  }
})();
