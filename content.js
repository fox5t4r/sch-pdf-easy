/**
 * SCH PDF Easy Downloader - Content Script (ISOLATED world)
 *
 * medlms.sch.ac.kr 강의콘텐츠 / 강의자료실 페이지에서 동작합니다.
 *
 * [핵심 아키텍처]
 * Chrome Content Script는 격리된 세계(isolated world)에서 실행되므로
 * 페이지의 React/Redux 변수(__reactFiber 등)에 직접 접근할 수 없습니다.
 *
 * 두 개의 스크립트로 분리:
 *   - injector.js (MAIN world): React Fiber 탐색 → Redux Store에서 PDF 목록 추출
 *   - content.js (ISOLATED world, 이 파일): UI 관리 + Chrome API(downloads, storage) 호출
 *
 * [스캔 전략]
 *   1차: Redux Store 스캔 (강의콘텐츠 LTI 콘텐츠 + 파일업로드 PDF)
 *   2차: Canvas File API 스캔 (직접 업로드 파일, 강의자료실)
 *   결과 병합 (contentId 기준 중복 제거)
 *
 * [다운로드 전략]
 *   최대 3개 병렬 다운로드
 */

(function () {
  'use strict';

  const COMMONS_BASE = 'https://commons.sch.ac.kr';
  const CONTENT_API = `${COMMONS_BASE}/viewer/ssplayer/uniplayer_support/content.php`;
  const VERSION = '1.4.0';
  const DL_CONCURRENCY = 5;

  let isRunning = false;
  let currentPDFs = [];
  let downloadedFiles = {};

  // ──────────────────────────────────────────────
  // SVG Icons (GitHub Octicons style)
  // ──────────────────────────────────────────────

  const I = {
    close: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>`,
    scan: `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>`,
    download: `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06Z"/></svg>`,
    all: `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8.75 2.75a.75.75 0 0 0-1.5 0v5.69L5.28 6.47a.75.75 0 0 0-1.06 1.06l3.25 3.25a.75.75 0 0 0 1.06 0l3.25-3.25a.75.75 0 0 0-1.06-1.06L8.75 8.44Z"/><path d="M2.5 13.25a.75.75 0 0 1 .75-.75h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75Z"/></svg>`,
    check: `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>`,
    file: `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688Z"/></svg>`,
    dlSmall: `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06Z"/></svg>`,
    spinner: `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" opacity=".35"/><path d="M8 0a8 8 0 0 1 8 8h-1.5A6.5 6.5 0 0 0 8 1.5Z"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.75s" repeatCount="indefinite"/></path></svg>`,
  };

  // ──────────────────────────────────────────────
  // 1. UI 삽입
  // ──────────────────────────────────────────────

  function injectUI() {
    if (document.getElementById('sch-pdf-easy-container')) return;

    const container = document.createElement('div');
    container.id = 'sch-pdf-easy-container';
    container.innerHTML = `
      <div id="sch-pdf-easy-panel">
        <div class="spe-header">
          <span class="spe-title">SCH PDF Easy</span>
          <span class="spe-version">v${VERSION}</span>
          <button id="spe-close-btn" class="spe-icon-btn" title="닫기">${I.close}</button>
        </div>
        <div id="spe-status" class="spe-status">
          <span class="spe-status-dot"></span>
          <span id="spe-status-text">LMS 페이지 로딩 대기 중...</span>
        </div>
        <div id="spe-progress-container" class="spe-progress-container" style="display:none;">
          <div class="spe-progress-bar">
            <div id="spe-progress-fill" class="spe-progress-fill"></div>
          </div>
          <span id="spe-progress-text" class="spe-progress-text">0/0</span>
        </div>
        <div id="spe-pdf-list" class="spe-pdf-list"></div>
        <div class="spe-btn-group">
          <button id="spe-scan-btn" class="spe-btn spe-btn-secondary">${I.scan} 스캔</button>
          <button id="spe-download-btn" class="spe-btn spe-btn-primary" disabled>${I.download} 새 파일</button>
          <button id="spe-download-all-btn" class="spe-btn spe-btn-outline" disabled>${I.all} 전체</button>
        </div>
        <div class="spe-footer">
          <button id="spe-clear-history-btn" class="spe-link-btn">기록 초기화</button>
        </div>
      </div>
      <button id="sch-pdf-easy-fab" title="SCH PDF Easy Downloader">PDF</button>
    `;
    document.body.appendChild(container);

    document.getElementById('sch-pdf-easy-fab').addEventListener('click', () => {
      const panel = document.getElementById('sch-pdf-easy-panel');
      const fab = document.getElementById('sch-pdf-easy-fab');
      panel.classList.toggle('spe-visible');
      fab.classList.toggle('spe-hidden');
      if (panel.classList.contains('spe-visible')) scanForPDFs();
    });

    document.getElementById('spe-close-btn').addEventListener('click', () => {
      document.getElementById('sch-pdf-easy-panel').classList.remove('spe-visible');
      document.getElementById('sch-pdf-easy-fab').classList.remove('spe-hidden');
    });

    document.getElementById('spe-scan-btn').addEventListener('click', () => scanForPDFs());
    document.getElementById('spe-download-btn').addEventListener('click', () => downloadNew());
    document.getElementById('spe-download-all-btn').addEventListener('click', () => downloadAll());
    document.getElementById('spe-clear-history-btn').addEventListener('click', clearHistory);
  }

  // ──────────────────────────────────────────────
  // 2. 상태 표시 헬퍼
  // ──────────────────────────────────────────────

  function setStatus(text, type = '') {
    const el = document.getElementById('spe-status');
    const textEl = document.getElementById('spe-status-text');
    if (!el || !textEl) return;
    el.className = 'spe-status' + (type ? ` spe-status-${type}` : '');
    textEl.textContent = text;
  }

  // ──────────────────────────────────────────────
  // 3. injector.js와 CustomEvent 통신 (강의콘텐츠)
  // ──────────────────────────────────────────────

  function requestScanFromInjector() {
    return new Promise((resolve) => {
      let resolved = false;

      function onResult(e) {
        if (resolved) return;
        resolved = true;
        document.removeEventListener('__SPE_SCAN_RESULT', onResult);
        resolve(e.detail);
      }

      document.addEventListener('__SPE_SCAN_RESULT', onResult);
      document.dispatchEvent(new CustomEvent('__SPE_SCAN_REQUEST'));

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          document.removeEventListener('__SPE_SCAN_RESULT', onResult);
          resolve({ success: false, error: 'timeout', pdfs: [] });
        }
      }, 10000);
    });
  }

  // ──────────────────────────────────────────────
  // 4. Canvas File API 스캔 (강의자료실 + 직접 업로드)
  // ──────────────────────────────────────────────

  function getCourseId() {
    const m = window.location.pathname.match(/\/courses\/(\d+)\//);
    return m ? m[1] : null;
  }

  async function scanCanvasFiles(courseId) {
    try {
      const res = await fetch(
        `/api/v1/courses/${courseId}/files?content_types[]=application/pdf&per_page=100&sort=created_at&order=desc`,
        { credentials: 'include' }
      );
      if (!res.ok) return [];
      const files = await res.json();
      if (!Array.isArray(files)) return [];
      return files.map((f) => ({
        title: (f.display_name || f.filename || 'untitled').replace(/\.pdf$/i, ''),
        contentId: `cf_${f.id}`,
        section: '강의자료',
        subsection: '',
        type: 'canvas_file',
        directUrl: f.url,
      }));
    } catch (e) {
      console.warn('[SCH PDF Easy] Canvas File API 실패:', e.message);
      return [];
    }
  }

  // ──────────────────────────────────────────────
  // 5. 다운로드 URL 획득
  // ──────────────────────────────────────────────

  async function getDownloadUrl(pdf) {
    // Canvas 파일 / 페이지 첨부 / 직접 업로드: URL이 이미 있음
    if (pdf.directUrl) {
      // 상대 URL(/courses/...) → 절대 URL로 변환
      if (pdf.directUrl.startsWith('/')) {
        return `https://medlms.sch.ac.kr${pdf.directUrl}`;
      }
      return pdf.directUrl;
    }

    // Commons 콘텐츠: content.php XML API로 다운로드 URL 획득
    const url = `${CONTENT_API}?content_id=${pdf.contentId}&_=${Date.now()}`;
    const response = await fetch(url);
    const text = await response.text();

    const xml = new DOMParser().parseFromString(text, 'text/xml');
    const downloadUri = xml.querySelector('content_download_uri');
    if (downloadUri && downloadUri.textContent) {
      return `${COMMONS_BASE}${downloadUri.textContent}`;
    }

    // fallback: 구형 commons 다운로드 URL 패턴
    return `${COMMONS_BASE}/index.php?module=xn_media_content2013&act=dispXn_media_content2013DownloadWebFile&site_id=sch1000001&content_id=${pdf.contentId}&web_storage_id=301&file_subpath=contents%5Cweb_files%5Coriginal.pdf`;
  }

  // ──────────────────────────────────────────────
  // 6. 스캔 로직 (Redux + Canvas API 병합)
  // ──────────────────────────────────────────────

  async function scanForPDFs() {
    const listEl = document.getElementById('spe-pdf-list');
    const dlBtn = document.getElementById('spe-download-btn');
    const dlAllBtn = document.getElementById('spe-download-all-btn');

    setStatus('스캔 중...');
    listEl.innerHTML = '';
    dlBtn.disabled = true;
    dlAllBtn.disabled = true;

    const courseId = getCourseId();

    // 1차: Redux 스캔 + Canvas File API 스캔 병렬 실행
    const [reduxResult, canvasFiles] = await Promise.all([
      requestScanFromInjector(),
      courseId ? scanCanvasFiles(courseId) : Promise.resolve([]),
    ]);

    // Redux 실패 시 재시도 (최대 2회)
    let finalRedux = reduxResult;
    if (!finalRedux.success && finalRedux.error !== 'timeout') {
      for (let i = 0; i < 2; i++) {
        setStatus(`재시도 중... (${i + 1}/2)`);
        await sleep(2000);
        finalRedux = await requestScanFromInjector();
        if (finalRedux.success) break;
      }
    }

    // 결과 병합 (contentId 기준 중복 제거)
    const seen = new Set();
    const allPDFs = [];

    const reduxPDFs = (finalRedux.success ? finalRedux.pdfs : []).map((p) => ({
      ...p,
      type: p.type || 'commons',
    }));

    for (const pdf of [...reduxPDFs, ...canvasFiles]) {
      if (!seen.has(pdf.contentId)) {
        seen.add(pdf.contentId);
        allPDFs.push(pdf);
      }
    }

    if (allPDFs.length === 0) {
      const reason = !finalRedux.success ? finalRedux.error || 'PDF 없음' : 'PDF 없음';
      setStatus(reason, canvasFiles.length === 0 ? 'warn' : 'warn');
      listEl.innerHTML = `<div class="spe-empty-state"><span>검색된 PDF 없음</span></div>`;
      return;
    }

    currentPDFs = allPDFs;

    downloadedFiles = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getDownloaded' }, resolve);
    });

    const newCount = currentPDFs.filter((p) => !downloadedFiles[p.contentId]).length;
    const sourceLabel = canvasFiles.length > 0 && !finalRedux.success ? ' (강의자료실)' : '';
    setStatus(`PDF ${currentPDFs.length}개${sourceLabel} (새 파일: ${newCount}개)`, 'ok');

    renderPDFList();

    dlAllBtn.disabled = false;
    if (newCount === 0) {
      dlBtn.innerHTML = `${I.check} 완료`;
      dlBtn.disabled = true;
    } else {
      dlBtn.innerHTML = `${I.download} 새 파일 (${newCount})`;
      dlBtn.disabled = false;
    }
  }

  function renderPDFList() {
    const listEl = document.getElementById('spe-pdf-list');
    listEl.innerHTML = '';

    currentPDFs.forEach((pdf) => {
      const isDownloaded = !!downloadedFiles[pdf.contentId];
      const item = document.createElement('div');
      item.className = `spe-pdf-item ${isDownloaded ? 'spe-downloaded' : 'spe-new'}`;
      item.innerHTML = `
        <span class="spe-pdf-status-icon ${isDownloaded ? 'done' : 'new'}">${isDownloaded ? I.check : I.file}</span>
        <div class="spe-pdf-item-info">
          <div class="spe-pdf-item-title">${escapeHtml(pdf.title)}</div>
          <div class="spe-pdf-item-meta">${escapeHtml(pdf.section)}${pdf.subsection ? ' · ' + escapeHtml(pdf.subsection) : ''}</div>
        </div>
        <button class="spe-pdf-item-dl spe-icon-btn" data-content-id="${pdf.contentId}" title="개별 다운로드">${I.dlSmall}</button>
      `;
      listEl.appendChild(item);

      item.querySelector('.spe-pdf-item-dl').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = I.spinner;
        await downloadSingle(pdf);
        markItemDone(btn, pdf.contentId);
      });
    });
  }

  function markItemDone(btn, contentId) {
    btn.innerHTML = I.check;
    btn.style.color = '#2da44e';
    const pdfItem = btn.closest('.spe-pdf-item');
    if (pdfItem) {
      pdfItem.className = 'spe-pdf-item spe-downloaded';
      const icon = pdfItem.querySelector('.spe-pdf-status-icon');
      if (icon) { icon.className = 'spe-pdf-status-icon done'; icon.innerHTML = I.check; }
    }
    // 버튼 카운트 업데이트
    const remaining = currentPDFs.filter((p) => !downloadedFiles[p.contentId]).length;
    const dlBtn = document.getElementById('spe-download-btn');
    if (dlBtn) {
      if (remaining === 0) { dlBtn.innerHTML = `${I.check} 완료`; dlBtn.disabled = true; }
      else { dlBtn.innerHTML = `${I.download} 새 파일 (${remaining})`; dlBtn.disabled = false; }
    }
  }

  // ──────────────────────────────────────────────
  // 7. 다운로드 (단일 / 병렬 배치)
  // ──────────────────────────────────────────────

  async function downloadSingle(pdf) {
    try {
      const downloadUrl = await getDownloadUrl(pdf);
      const filename = `${sanitizeFilename(pdf.title)}.pdf`;
      const urlWithName = pdf.directUrl
        ? downloadUrl
        : `${downloadUrl}&file_name=${encodeURIComponent(pdf.title)}`;

      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'downloadPDF', url: urlWithName, filename, contentId: pdf.contentId, title: pdf.title },
          resolve
        );
      });

      downloadedFiles[pdf.contentId] = { title: pdf.title, downloadedAt: new Date().toISOString() };
    } catch (err) {
      console.error(`[SCH PDF Easy] 다운로드 실패: ${pdf.title}`, err);
    }
  }

  async function downloadNew() {
    if (isRunning) return;
    isRunning = true;
    await downloadBatch(currentPDFs.filter((p) => !downloadedFiles[p.contentId]));
    isRunning = false;
  }

  async function downloadAll() {
    if (isRunning) return;
    isRunning = true;
    await downloadBatch(currentPDFs);
    isRunning = false;
  }

  async function downloadBatch(pdfs) {
    const progressContainer = document.getElementById('spe-progress-container');
    const progressFill = document.getElementById('spe-progress-fill');
    const progressText = document.getElementById('spe-progress-text');
    const dlBtn = document.getElementById('spe-download-btn');
    const dlAllBtn = document.getElementById('spe-download-all-btn');

    if (pdfs.length === 0) return;

    dlBtn.disabled = true;
    dlAllBtn.disabled = true;
    progressContainer.style.display = 'flex';
    progressFill.style.width = '0%';

    let completed = 0;
    const total = pdfs.length;
    const queue = [...pdfs];

    // 병렬 worker: queue에서 꺼내 순차 처리, 최대 DL_CONCURRENCY개 동시 실행
    async function worker() {
      while (queue.length > 0) {
        const pdf = queue.shift();
        if (!pdf) break;

        try {
          await downloadSingle(pdf);
          const btn = document.querySelector(`[data-content-id="${pdf.contentId}"]`);
          if (btn) markItemDone(btn, pdf.contentId);
        } catch (err) {
          console.error(`[SCH PDF Easy] 실패: ${pdf.title}`, err);
        }

        completed++;
        progressFill.style.width = `${Math.round((completed / total) * 100)}%`;
        progressText.textContent = `${completed}/${total}`;
        setStatus(`다운로드 중... (${completed}/${total})`);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(DL_CONCURRENCY, total) }, worker)
    );

    setStatus(`${completed}개 다운로드 완료`, 'ok');

    const remaining = currentPDFs.filter((p) => !downloadedFiles[p.contentId]).length;
    if (remaining === 0) {
      dlBtn.innerHTML = `${I.check} 완료`;
      dlBtn.disabled = true;
    } else {
      dlBtn.innerHTML = `${I.download} 새 파일 (${remaining})`;
      dlBtn.disabled = false;
    }
    dlAllBtn.disabled = false;

    setTimeout(() => { progressContainer.style.display = 'none'; }, 3000);
  }

  async function clearHistory() {
    if (!confirm('다운로드 기록을 초기화하시겠습니까?\n(이미 다운로드한 파일은 삭제되지 않습니다)')) return;
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'clearDownloaded' }, resolve);
    });
    downloadedFiles = {};
    scanForPDFs();
  }

  // ──────────────────────────────────────────────
  // 8. 유틸리티
  // ──────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
  }

  // ──────────────────────────────────────────────
  // 9. 초기화
  // ──────────────────────────────────────────────

  function init() {
    if (!window.location.href.includes('external_tools')) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectUI);
    } else {
      injectUI();
    }
  }

  init();
})();
