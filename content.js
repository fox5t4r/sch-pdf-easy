/**
 * SCH PDF Easy Downloader - Content Script (ISOLATED world)
 *
 * medlms.sch.ac.kr 강의콘텐츠 페이지에서 동작합니다.
 *
 * [핵심 아키텍처]
 * Chrome Content Script는 격리된 세계(isolated world)에서 실행되므로
 * 페이지의 React/Redux 변수(__reactFiber 등)에 직접 접근할 수 없습니다.
 *
 * 따라서 두 개의 스크립트로 분리합니다:
 *   - injector.js (MAIN world): React Fiber 탐색 → Redux Store에서 PDF 목록 추출
 *   - content.js (ISOLATED world, 이 파일): UI 관리 + Chrome API(downloads, storage) 호출
 *
 * 통신 방식: CustomEvent를 통한 양방향 메시징
 *   content.js → injector.js : '__SPE_SCAN_REQUEST' 이벤트
 *   injector.js → content.js : '__SPE_SCAN_RESULT' 이벤트 (detail에 PDF 목록)
 */

(function () {
  'use strict';

  const COMMONS_BASE = 'https://commons.sch.ac.kr';
  const CONTENT_API = `${COMMONS_BASE}/viewer/ssplayer/uniplayer_support/content.php`;

  let isRunning = false;
  let currentPDFs = [];
  let downloadedFiles = {};

  // ──────────────────────────────────────────────
  // 1. UI: 다운로드 버튼 삽입
  // ──────────────────────────────────────────────

  function injectUI() {
    if (document.getElementById('sch-pdf-easy-container')) return;

    const container = document.createElement('div');
    container.id = 'sch-pdf-easy-container';
    container.innerHTML = `
      <div id="sch-pdf-easy-panel">
        <div class="spe-header">
          <span class="spe-logo">📄</span>
          <span class="spe-title">SCH PDF Easy</span>
          <button id="spe-close-btn" class="spe-icon-btn" title="닫기">✕</button>
        </div>
        <div id="spe-status" class="spe-status">LMS 페이지 로딩 대기 중...</div>
        <div id="spe-progress-container" class="spe-progress-container" style="display:none;">
          <div class="spe-progress-bar">
            <div id="spe-progress-fill" class="spe-progress-fill"></div>
          </div>
          <span id="spe-progress-text" class="spe-progress-text">0/0</span>
        </div>
        <div id="spe-pdf-list" class="spe-pdf-list"></div>
        <div class="spe-btn-group">
          <button id="spe-scan-btn" class="spe-btn spe-btn-secondary" title="PDF 목록 새로고침">🔍 스캔</button>
          <button id="spe-download-btn" class="spe-btn spe-btn-primary" disabled>⬇️ 새 PDF 다운로드</button>
          <button id="spe-download-all-btn" class="spe-btn spe-btn-outline" disabled>📦 전체 다운로드</button>
        </div>
        <div class="spe-footer">
          <button id="spe-clear-history-btn" class="spe-link-btn">다운로드 기록 초기화</button>
        </div>
      </div>
      <button id="sch-pdf-easy-fab" title="SCH PDF Easy Downloader">
        <span>📄</span>
      </button>
    `;
    document.body.appendChild(container);

    // FAB 버튼 → 패널 토글
    document.getElementById('sch-pdf-easy-fab').addEventListener('click', () => {
      const panel = document.getElementById('sch-pdf-easy-panel');
      const fab = document.getElementById('sch-pdf-easy-fab');
      panel.classList.toggle('spe-visible');
      fab.classList.toggle('spe-hidden');
      if (panel.classList.contains('spe-visible')) {
        scanForPDFs();
      }
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
  // 2. injector.js와 CustomEvent 통신
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

      // injector.js에 스캔 요청 전송
      document.dispatchEvent(new CustomEvent('__SPE_SCAN_REQUEST'));

      // 타임아웃: 15초 후에도 응답 없으면 실패
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          document.removeEventListener('__SPE_SCAN_RESULT', onResult);
          resolve({
            success: false,
            error: 'injector.js로부터 응답이 없습니다. 페이지를 새로고침 해주세요.',
          });
        }
      }, 15000);
    });
  }

  // ──────────────────────────────────────────────
  // 3. content.php API로 다운로드 URL 획득
  // ──────────────────────────────────────────────

  async function getDownloadUrl(contentId) {
    const url = `${CONTENT_API}?content_id=${contentId}&_=${Date.now()}`;
    const response = await fetch(url);
    const text = await response.text();

    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');

    const downloadUri = xml.querySelector('content_download_uri');
    if (downloadUri && downloadUri.textContent) {
      return `${COMMONS_BASE}${downloadUri.textContent}`;
    }

    // fallback: 기본 패턴
    return `${COMMONS_BASE}/index.php?module=xn_media_content2013&act=dispXn_media_content2013DownloadWebFile&site_id=sch1000001&content_id=${contentId}&web_storage_id=301&file_subpath=contents%5Cweb_files%5Coriginal.pdf`;
  }

  // ──────────────────────────────────────────────
  // 4. 스캔 / 다운로드 로직
  // ──────────────────────────────────────────────

  async function scanForPDFs() {
    const statusEl = document.getElementById('spe-status');
    const listEl = document.getElementById('spe-pdf-list');
    const dlBtn = document.getElementById('spe-download-btn');
    const dlAllBtn = document.getElementById('spe-download-all-btn');

    statusEl.textContent = '🔍 PDF 스캔 중...';
    statusEl.className = 'spe-status';
    listEl.innerHTML = '';
    dlBtn.disabled = true;
    dlAllBtn.disabled = true;

    // iframe 로딩 대기 후 injector.js에 스캔 요청
    // (iframe이 아직 로드 안 됐을 수 있으므로 최대 3회 재시도)
    let result = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        statusEl.textContent = `🔍 재시도 중... (${attempt + 1}/3)`;
        await sleep(2000);
      }
      result = await requestScanFromInjector();
      if (result.success) break;
    }

    if (!result || !result.success) {
      statusEl.textContent = `⚠️ ${result?.error || 'PDF를 찾을 수 없습니다.'}`;
      statusEl.className = 'spe-status spe-status-error';
      return;
    }

    currentPDFs = result.pdfs;

    if (currentPDFs.length === 0) {
      statusEl.textContent = '📭 이 과목에 PDF 자료가 없습니다.';
      statusEl.className = 'spe-status spe-status-warn';
      return;
    }

    // 다운로드 기록 가져오기
    downloadedFiles = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getDownloaded' }, resolve);
    });

    const newCount = currentPDFs.filter(
      (p) => !downloadedFiles[p.contentId]
    ).length;

    statusEl.textContent = `📚 총 ${currentPDFs.length}개 PDF 발견 (새 파일: ${newCount}개)`;
    statusEl.className = 'spe-status spe-status-ok';

    // 목록 렌더링
    currentPDFs.forEach((pdf) => {
      const isDownloaded = !!downloadedFiles[pdf.contentId];
      const item = document.createElement('div');
      item.className = `spe-pdf-item ${isDownloaded ? 'spe-downloaded' : 'spe-new'}`;
      item.innerHTML = `
        <div class="spe-pdf-item-icon">${isDownloaded ? '✅' : '📄'}</div>
        <div class="spe-pdf-item-info">
          <div class="spe-pdf-item-title">${escapeHtml(pdf.title)}</div>
          <div class="spe-pdf-item-meta">${escapeHtml(pdf.section)} · ${escapeHtml(pdf.subsection)}</div>
        </div>
        <button class="spe-pdf-item-dl spe-icon-btn" data-content-id="${pdf.contentId}" data-title="${escapeHtml(pdf.title)}" title="개별 다운로드">⬇️</button>
      `;
      listEl.appendChild(item);

      item.querySelector('.spe-pdf-item-dl').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '⏳';
        await downloadSingle(pdf);
        btn.textContent = '✅';
      });
    });

    dlBtn.disabled = newCount === 0;
    dlAllBtn.disabled = false;

    if (newCount === 0) {
      dlBtn.textContent = '✅ 모두 다운로드 완료';
    } else {
      dlBtn.textContent = `⬇️ 새 PDF 다운로드 (${newCount})`;
    }
  }

  async function downloadSingle(pdf) {
    try {
      const downloadUrl = await getDownloadUrl(pdf.contentId);
      const safeTitle = sanitizeFilename(pdf.title);
      const filename = `${safeTitle}.pdf`;

      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: 'downloadPDF',
            url: `${downloadUrl}&file_name=${encodeURIComponent(pdf.title)}`,
            filename,
            contentId: pdf.contentId,
            title: pdf.title,
          },
          resolve
        );
      });

      downloadedFiles[pdf.contentId] = {
        title: pdf.title,
        downloadedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.error(`[SCH PDF Easy] 다운로드 실패: ${pdf.title}`, err);
    }
  }

  async function downloadNew() {
    if (isRunning) return;
    isRunning = true;
    const newPDFs = currentPDFs.filter((p) => !downloadedFiles[p.contentId]);
    await downloadBatch(newPDFs);
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
    const statusEl = document.getElementById('spe-status');
    const dlBtn = document.getElementById('spe-download-btn');
    const dlAllBtn = document.getElementById('spe-download-all-btn');

    dlBtn.disabled = true;
    dlAllBtn.disabled = true;
    progressContainer.style.display = 'flex';

    let completed = 0;
    const total = pdfs.length;

    for (const pdf of pdfs) {
      statusEl.textContent = `⬇️ 다운로드 중: ${pdf.title}`;
      statusEl.className = 'spe-status';

      try {
        await downloadSingle(pdf);

        const item = document.querySelector(
          `[data-content-id="${pdf.contentId}"]`
        );
        if (item) {
          item.textContent = '✅';
          const pdfItem = item.closest('.spe-pdf-item');
          if (pdfItem) {
            pdfItem.className = 'spe-pdf-item spe-downloaded';
            const icon = pdfItem.querySelector('.spe-pdf-item-icon');
            if (icon) icon.textContent = '✅';
          }
        }
      } catch (err) {
        console.error(`[SCH PDF Easy] 실패: ${pdf.title}`, err);
      }

      completed++;
      const pct = Math.round((completed / total) * 100);
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `${completed}/${total}`;

      // 서버 부하 방지 딜레이 (1초)
      if (completed < total) {
        await sleep(1000);
      }
    }

    statusEl.textContent = `✅ ${completed}개 파일 다운로드 완료!`;
    statusEl.className = 'spe-status spe-status-ok';

    const newCount = currentPDFs.filter(
      (p) => !downloadedFiles[p.contentId]
    ).length;
    if (newCount === 0) {
      dlBtn.textContent = '✅ 모두 다운로드 완료';
      dlBtn.disabled = true;
    } else {
      dlBtn.textContent = `⬇️ 새 PDF 다운로드 (${newCount})`;
      dlBtn.disabled = false;
    }
    dlAllBtn.disabled = false;

    setTimeout(() => {
      progressContainer.style.display = 'none';
    }, 3000);
  }

  async function clearHistory() {
    if (!confirm('다운로드 기록을 초기화하시겠습니까?\n(이미 다운로드한 파일은 삭제되지 않습니다)')) {
      return;
    }
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'clearDownloaded' }, resolve);
    });
    downloadedFiles = {};
    scanForPDFs();
  }

  // ──────────────────────────────────────────────
  // 5. 유틸리티
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
    return name
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ──────────────────────────────────────────────
  // 6. 초기화
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
