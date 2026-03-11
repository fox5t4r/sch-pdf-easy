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
 *   최대 5개 병렬 다운로드
 */

(function () {
  'use strict';

  const COMMONS_BASE = 'https://commons.sch.ac.kr';
  const CONTENT_API = `${COMMONS_BASE}/viewer/ssplayer/uniplayer_support/content.php`;
  const VERSION = '1.6.7';
  const DL_CONCURRENCY = 5;
  const Shared = globalThis.SpeShared || {};

  let isRunning = false;
  let currentPDFs = [];
  let downloadedFiles = {};
  let _progressTimer = null;

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
          <button id="spe-diag-btn" class="spe-link-btn">진단 복사</button>
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
    document.getElementById('spe-diag-btn').addEventListener('click', copyDiagnostics);
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

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  async function getDownloadedFilesSafe() {
    try {
      const response = await sendRuntimeMessage({ action: 'getDownloaded' });
      return response && typeof response === 'object' ? response : {};
    } catch (err) {
      console.warn('[SCH PDF Easy] 다운로드 기록 조회 실패:', err);
      return {};
    }
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
    const allFiles = [];
    let nextUrl =
      `/api/v1/courses/${courseId}/files?` +
      `content_types[]=application/pdf` +
      `&content_types[]=application/vnd.ms-powerpoint` +
      `&content_types[]=application/vnd.openxmlformats-officedocument.presentationml.presentation` +
      `&per_page=100&sort=created_at&order=desc`;

    try {
      while (nextUrl) {
        const res = await fetch(nextUrl, { credentials: 'include' });
        if (!res.ok) break;

        const files = await res.json();
        if (!Array.isArray(files)) break;
        allFiles.push(...files);

        const linkHeader = res.headers.get('Link');
        nextUrl = Shared.getNextLinkFromHeader ? Shared.getNextLinkFromHeader(linkHeader) : null;
      }

      return allFiles
        // f.id 또는 f.url 누락 시 제외 — cf_undefined contentId / undefined directUrl 방지
        .filter((f) => f.id && f.url)
        .map((f) => {
          const fname = f.display_name || f.filename || '';
          const ext = /\.pptx$/i.test(fname) ? 'pptx' : /\.ppt$/i.test(fname) ? 'ppt' : 'pdf';
          return {
            title: fname.replace(/\.(pdf|pptx?)$/i, '') || 'untitled',
            contentId: `cf_${f.id}`,
            section: '강의자료',
            subsection: '',
            type: 'canvas_file',
            ext,
            directUrl: f.url,
          };
        });
    } catch (e) {
      return [];
    }
  }

  // ──────────────────────────────────────────────
  // 5. 다운로드 URL 획득
  // ──────────────────────────────────────────────

  async function getDownloadUrl(pdf) {
    // Canvas 파일 / 페이지 첨부 / 직접 업로드: URL이 이미 있음
    if (pdf.directUrl) {
      if (pdf.directUrl.startsWith('/')) {
        return `https://medlms.sch.ac.kr${pdf.directUrl}`;
      }
      return pdf.directUrl;
    }

    // Commons 콘텐츠: content.php XML API로 다운로드 URL 획득
    // lx_resource는 commons_content.content_id(lxContentId)를 사용해야 정상 응답
    const effectiveContentId = (pdf.type === 'lx_resource' && pdf.lxContentId)
      ? pdf.lxContentId
      : pdf.contentId;
    const url = `${CONTENT_API}?content_id=${encodeURIComponent(effectiveContentId)}&_=${Date.now()}`;
    const response = await fetch(url);
    const text = await response.text();
    const xml = new DOMParser().parseFromString(text, 'text/xml');
    const downloadUri = xml.querySelector('content_download_uri');
    if (downloadUri && downloadUri.textContent) {
      return `${COMMONS_BASE}${downloadUri.textContent}`;
    }

    // sharedocs 타입: content_uri에서 source 경로 구성 시도
    const contentType = xml.querySelector('content_type');
    const contentUri = xml.querySelector('content_uri');
    if (contentType && contentType.textContent === 'sharedocs' && contentUri && contentUri.textContent) {
      // content_uri: .../contents/web_files → .../contents/source/original.pdf 시도
      const base = contentUri.textContent.replace(/\/web_files\/?$/, '');
      return `${base}/source/original.${pdf.ext || 'pdf'}`;
    }

    // fallback: 구형 commons 다운로드 URL 패턴
    return `${COMMONS_BASE}/index.php?module=xn_media_content2013&act=dispXn_media_content2013DownloadWebFile&site_id=sch1000001&content_id=${effectiveContentId}&web_storage_id=301&file_subpath=contents%5Cweb_files%5Coriginal.pdf`;
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

    const reduxPDFs = (finalRedux.success ? finalRedux.pdfs : []).map((p) => ({
      ...p,
      type: p.type || 'commons',
    }));
    const allPDFs = Shared.mergeUniqueByContentId
      ? Shared.mergeUniqueByContentId(reduxPDFs, canvasFiles)
      : [...reduxPDFs, ...canvasFiles];

    if (allPDFs.length === 0) {
      const reason = !finalRedux.success ? finalRedux.error || 'PDF 없음' : 'PDF 없음';
      setStatus(reason, 'warn');
      listEl.innerHTML = `<div class="spe-empty-state"><span>검색된 파일 없음</span></div>`;
      return;
    }

    currentPDFs = allPDFs;

    downloadedFiles = await getDownloadedFilesSafe();

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
        <button class="spe-pdf-item-dl spe-icon-btn" title="개별 다운로드">${I.dlSmall}</button>
      `;
      // contentId는 innerHTML 보간 대신 안전하게 속성으로 직접 설정
      item.querySelector('.spe-pdf-item-dl').dataset.contentId = pdf.contentId;
      listEl.appendChild(item);

      item.querySelector('.spe-pdf-item-dl').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = I.spinner;
        try {
          const succeeded = await downloadSingle(pdf);
          if (succeeded) {
            markItemDone(btn, pdf.contentId);
            return;
          }
        } catch (err) {
          console.error(`[SCH PDF Easy] 다운로드 실패: ${pdf.title}`, err);
          setStatus(`다운로드 실패: ${pdf.title}`, 'error');
        }

        btn.disabled = false;
        btn.innerHTML = I.dlSmall;
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
    const downloadUrl = await getDownloadUrl(pdf);
    const filename = `${sanitizeFilename(pdf.title)}.${pdf.ext || 'pdf'}`;
    // directUrl 또는 lx_resource는 &file_name 파라미터 불필요 (URL 구조 다름)
    const urlWithName = (pdf.directUrl || pdf.type === 'lx_resource')
      ? downloadUrl
      : `${downloadUrl}&file_name=${encodeURIComponent(pdf.title)}`;

    const response = await sendRuntimeMessage({
      action: 'downloadPDF',
      url: urlWithName,
      filename,
      contentId: pdf.contentId,
      title: pdf.title,
    });

    if (!(Shared.isDownloadResponseSuccess ? Shared.isDownloadResponseSuccess(response) : response && response.success)) {
      throw new Error((response && response.error) || '다운로드 요청 실패');
    }

    downloadedFiles[pdf.contentId] = { title: pdf.title, downloadedAt: new Date().toISOString() };
    return true;
  }

  async function downloadNew() {
    if (isRunning) return;
    isRunning = true;
    try {
      await downloadBatch(currentPDFs.filter((p) => !downloadedFiles[p.contentId]));
    } finally {
      isRunning = false;
    }
  }

  async function downloadAll() {
    if (isRunning) return;
    isRunning = true;
    try {
      await downloadBatch(currentPDFs);
    } finally {
      isRunning = false;
    }
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
    clearTimeout(_progressTimer); // 이전 batch 완료 타이머 취소
    progressContainer.style.display = 'flex';
    progressFill.style.width = '0%';
    progressText.textContent = `0/${pdfs.length}`;

    let completed = 0;
    let failed = 0;
    const total = pdfs.length;
    const queue = [...pdfs];

    // 병렬 worker: queue에서 꺼내 순차 처리, 최대 DL_CONCURRENCY개 동시 실행
    async function worker() {
      while (queue.length > 0) {
        const pdf = queue.shift();

        try {
          const succeeded = await downloadSingle(pdf);
          // CSS.escape: contentId에 ] 또는 " 포함 시 selector 파싱 오류 방지
          const btn = document.querySelector(`[data-content-id="${CSS.escape(pdf.contentId)}"]`);
          if (btn && succeeded) markItemDone(btn, pdf.contentId);
        } catch (err) {
          failed++;
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

    if (failed > 0) {
      setStatus(`${completed - failed}개 다운로드 완료, ${failed}개 실패`, 'warn');
    } else {
      setStatus(`${completed}개 다운로드 완료`, 'ok');
    }

    const remaining = currentPDFs.filter((p) => !downloadedFiles[p.contentId]).length;
    if (remaining === 0) {
      dlBtn.innerHTML = `${I.check} 완료`;
      dlBtn.disabled = true;
    } else {
      dlBtn.innerHTML = `${I.download} 새 파일 (${remaining})`;
      dlBtn.disabled = false;
    }
    dlAllBtn.disabled = false;

    _progressTimer = setTimeout(() => { progressContainer.style.display = 'none'; }, 3000);
  }

  async function clearHistory() {
    if (!confirm('다운로드 기록을 초기화하시겠습니까?\n(이미 다운로드한 파일은 삭제되지 않습니다)')) return;
    await sendRuntimeMessage({ action: 'clearDownloaded' });
    downloadedFiles = {};
    scanForPDFs();
  }

  // ──────────────────────────────────────────────
  // 8. 진단
  // ──────────────────────────────────────────────

  async function copyDiagnostics() {
    const btn = document.getElementById('spe-diag-btn');
    btn.textContent = '수집 중...';
    btn.disabled = true;

    const lines = [];
    lines.push(`=== SCH PDF Easy v${VERSION} 진단 ===`);
    lines.push(`URL: ${window.location.href}`);
    lines.push(`시간: ${new Date().toISOString()}`);
    lines.push('');

    // injector에서 LX 캐시 상태 수집
    const inj = await new Promise((resolve) => {
      let done = false;
      function handler(e) {
        document.removeEventListener('__SPE_DIAG_RESULT', handler);
        done = true;
        resolve(e.detail);
      }
      document.addEventListener('__SPE_DIAG_RESULT', handler);
      document.dispatchEvent(new CustomEvent('__SPE_DIAG_REQUEST'));
      setTimeout(() => { if (!done) { document.removeEventListener('__SPE_DIAG_RESULT', handler); resolve(null); } }, 3000);
    });

    if (inj) {
      lines.push(`LX courseId: ${inj.courseId || '없음'}`);
      lines.push(`LX resources (캐시): ${inj.resourceCount}개`);
      if (inj.resourceKeys) lines.push(`Resource 키: ${inj.resourceKeys}`);
      lines.push(`캡처된 LX API URLs: ${inj.interceptedUrls || '없음'}`);
      if (inj.iframeUrl) lines.push(`iframe URL: ${inj.iframeUrl}`);
      lines.push(`React 버전: ${inj.reactVersion || '알 수 없음'}`);
      lines.push(`React props 추출: ${inj.reactExtractResult || '미테스트'}`);
      lines.push(`.xn-resource-item React 키: ${inj.itemReactKeys || '확인 불가'}`);
      if (inj.sample) {
        lines.push(`샘플 resource_id: ${inj.sample.resource_id}`);
        lines.push(`샘플 commons_content.content_id: ${inj.sample.commonsContentId || '없음'}`);
        lines.push(`샘플 progress_support: ${inj.sample.commonsProgressSupport}`);
      }
    } else {
      lines.push('LX 캐시: injector 응답 없음 (강의자료실 페이지가 아닐 수 있음)');
    }
    lines.push('');

    // LX resources API 직접 테스트
    const courseId = (window.location.pathname.match(/\/courses\/(\d+)/) || [])[1];
    if (courseId) {
      lines.push(`LX resources API 직접 테스트 (courseId=${courseId}):`);
      try {
        const r = await fetch(`/learningx/api/v1/courses/${courseId}/resources`, { credentials: 'include' });
        lines.push(`  HTTP 상태: ${r.status}`);
        const body = await r.text();
        if (r.ok) {
          try {
            const parsed = JSON.parse(body);
            const arr = Array.isArray(parsed) ? parsed : null;
            if (arr) {
              lines.push(`  결과: ${arr.length}개`);
              if (arr[0]) lines.push(`  첫번째 키: ${Object.keys(arr[0]).join(', ')}`);
              if (arr[0] && arr[0].commons_content) lines.push(`  commons_content.content_id: ${arr[0].commons_content.content_id || '없음'}`);
            } else {
              lines.push(`  결과: 배열 아님 — ${body.slice(0, 100)}`);
            }
          } catch (e) {
            lines.push(`  JSON 파싱 실패: ${body.slice(0, 100)}`);
          }
        } else {
          lines.push(`  오류 응답: ${body.slice(0, 150)}`);
        }
      } catch (e) {
        lines.push(`  예외: ${e.message}`);
      }
      lines.push('');
    }

    // 스캔된 파일 없으면 먼저 스캔
    if (currentPDFs.length === 0) {
      lines.push('스캔된 파일 없음 — 스캔 후 다시 시도하세요.');
    } else {
      lines.push(`스캔된 파일: ${currentPDFs.length}개`);
      lines.push('');
      for (let i = 0; i < currentPDFs.length; i++) {
        const pdf = currentPDFs[i];
        lines.push(`[파일 ${i}] ${pdf.title}`);
        lines.push(`  type: ${pdf.type}, ext: ${pdf.ext}`);
        lines.push(`  contentId: ${pdf.contentId}`);
        if (pdf.lxContentId) lines.push(`  lxContentId: ${pdf.lxContentId}`);
        if (pdf.directUrl) { lines.push(`  directUrl: ${pdf.directUrl}`); continue; }

        const eid = (pdf.type === 'lx_resource' && pdf.lxContentId) ? pdf.lxContentId : pdf.contentId;
        try {
          const resp = await fetch(`${CONTENT_API}?content_id=${encodeURIComponent(eid)}&_=${Date.now()}`);
          const text = await resp.text();
          lines.push(`  content.php 상태: ${resp.status}`);
          lines.push(`  content.php 원문: ${text.substring(0, 1000).replace(/\n/g, ' ')}`);
          try {
            const xmlDoc = new DOMParser().parseFromString(text, 'text/xml');
            const fields = ['content_type','content_uri','content_download_uri','content_name','content_id'];
            fields.forEach(f => {
              const el = xmlDoc.querySelector(f);
              if (el) lines.push(`  [XML] ${f}: ${el.textContent}`);
            });
          } catch(xe) {
            lines.push(`  XML 파싱 실패: ${xe.message}`);
          }
        } catch (e) {
          lines.push(`  content.php 오류: ${e.message}`);
        }
        lines.push('');
      }
    }

    const output = lines.join('\n');
    try {
      await navigator.clipboard.writeText(output);
      btn.textContent = '복사됨!';
    } catch (e) {
      // 클립보드 실패 시 텍스트 영역으로 표시
      const ta = document.createElement('textarea');
      ta.value = output;
      ta.style.cssText = 'position:fixed;top:10px;left:10px;width:80vw;height:60vh;z-index:99999;font-size:11px;';
      document.body.appendChild(ta);
      ta.select();
      btn.textContent = '텍스트 선택됨';
      setTimeout(() => ta.remove(), 15000);
    }
    setTimeout(() => { btn.textContent = '진단 복사'; btn.disabled = false; }, 2000);
  }

  // ──────────────────────────────────────────────
  // 9. 유틸리티
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
  // 10. 초기화
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
