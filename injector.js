/**
 * SCH PDF Easy Downloader - Injector (MAIN world)
 *
 * 이 스크립트는 페이지의 MAIN world에서 실행되어
 * React/Redux 내부 변수에 직접 접근합니다.
 * 추출한 PDF 목록을 CustomEvent로 content.js(ISOLATED world)에 전달합니다.
 *
 * Content Script(isolated)에서는 __reactFiber 등 페이지 JS 속성에
 * 접근할 수 없기 때문에 이 분리가 필요합니다.
 */

(function () {
  'use strict';

  // content.js에서 스캔 요청을 받으면 실행
  document.addEventListener('__SPE_SCAN_REQUEST', () => {
    console.log('[SCH PDF Easy Injector] 스캔 요청 수신');
    performScan();
  });

  function performScan() {
    // iframe 찾기
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

    // React Fiber 키 찾기
    const fiberKey = Object.keys(root).find(
      (k) => k.startsWith('__reactFiber') || k.startsWith('__reactContainer')
    );
    if (!fiberKey) {
      sendResult({ success: false, error: 'React Fiber를 찾을 수 없습니다. (페이지 로딩 중?)' });
      return;
    }

    // Redux Store 찾기
    const store = findStore(root[fiberKey], 0);
    if (!store) {
      sendResult({ success: false, error: 'Redux Store를 찾을 수 없습니다.' });
      return;
    }

    // PDF 목록 추출
    try {
      const state = store.getState();
      const sections = state.sections.sections;
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
      if (!section.subsections) return;
      section.subsections.forEach((sub) => {
        if (!sub.units) return;
        sub.units.forEach((unit) => {
          if (!unit.components) return;
          unit.components.forEach((comp) => {
            if (
              comp.commons_content &&
              comp.commons_content.content_type === 'pdf'
            ) {
              pdfs.push({
                title: comp.title,
                contentId: comp.commons_content.content_id,
                section: section.title,
                subsection: sub.title,
              });
            }
          });
        });
      });
    });
    return pdfs;
  }

  function sendResult(data) {
    console.log('[SCH PDF Easy Injector] 결과 전송:', data.success ? `${data.pdfs?.length}개 PDF` : data.error);
    document.dispatchEvent(
      new CustomEvent('__SPE_SCAN_RESULT', { detail: data })
    );
  }
})();
