/**
 * SCH PDF Easy Downloader - Content Script
 *
 * medlms.sch.ac.kr 강의콘텐츠 페이지에서 동작합니다.
 * LTI iframe 내부의 Redux Store에서 PDF 목록을 추출하고,
 * commons.sch.ac.kr의 content.php API로 다운로드 URL을 구성합니다.
 *
 * 구조:
 *   medlms.sch.ac.kr (Canvas LMS)
 *     └─ iframe#tool_content (LTI coursebuilder)
 *          └─ React App + Redux Store
 *               └─ sections → subsections → units → components
 *                    └─ commons_content.content_id → content.php API → download URL
 */

(function () {
  'use strict';

  const COMMONS_BASE = 'https://commons.sch.ac.kr';
  const CONTENT_API = `${COMMONS_BASE}/viewer/ssplayer/uniplayer_support/content.php`;

  let isRunning = false;

  // ──────────────────────────────────────────────
  // 1. UI: 다운로드 버튼 삽입
  // ──────────────────────────────────────────────

  function injectUI() {
    // 이미 삽입되었으면 무시
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

    // FAB 버튼 클릭 → 패널 토글
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
  // 2. Redux Store에서 PDF 목록 추출
  // ──────────────────────────────────────────────

  function getReduxStore() {
    const iframe = document.getElementById('tool_content');
    if (!iframe) return null;

    let iframeDoc;
    try {
      iframeDoc = iframe.contentDocument;
    } catch (e) {
      return null;
    }
    if (!iframeDoc) return null;

    const root = iframeDoc.getElementById('root');
    if (!root) return null;

    const fiberKey = Object.keys(root).find(
      (k) => k.startsWith('__reactFiber') || k.startsWith('__reactContainer')
    );
    if (!fiberKey) return null;

    function findStore(node, depth) {
      if (!node || depth > 25) return null;
      if (node.memoizedProps && node.memoizedProps.store) {
        return node.memoizedProps.store;
      }
      return findStore(node.child, depth + 1) || findStore(node.sibling, depth + 1);
    }

    return findStore(root[fiberKey], 0);
  }

  function extractPDFs(store) {
    const state = store.getState();
    const sections = state.sections.sections;
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

    // fallback: 기본 패턴으로 구성
    return `${COMMONS_BASE}/index.php?module=xn_media_content2013&act=dispXn_media_content2013DownloadWebFile&site_id=sch1000001&content_id=${contentId}&web_storage_id=301&file_subpath=contents%5Cweb_files%5Coriginal.pdf`;
  }

  // ──────────────────────────────────────────────
  // 4. 스캔 / 다운로드 로직
  // ──────────────────────────────────────────────

  let currentPDFs = [];
  let downloadedFiles = {};

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

    // iframe 로딩 대기 (최대 10초)
    let store = null;
    for (let i = 0; i < 20; i++) {
      store = getReduxStore();
      if (store) break;
      await sleep(500);
    }

    if (!store) {
      statusEl.textContent = '⚠️ LMS 콘텐츠를 찾을 수 없습니다. 페이지를 새로고침 해주세요.';
      statusEl.className = 'spe-status spe-status-error';
      return;
    }

    currentPDFs = extractPDFs(store);

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

      // 개별 다운로드 버튼
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

      // UI 업데이트
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

        // 목록 아이템 업데이트
        const item = document.querySelector(
          `[data-content-id="${pdf.contentId}"]`
        );
        if (item) {
          item.textContent = '✅';
          item.closest('.spe-pdf-item').className = 'spe-pdf-item spe-downloaded';
          item.closest('.spe-pdf-item').querySelector('.spe-pdf-item-icon').textContent = '✅';
        }
      } catch (err) {
        console.error(`[SCH PDF Easy] 실패: ${pdf.title}`, err);
      }

      completed++;
      const pct = Math.round((completed / total) * 100);
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `${completed}/${total}`;

      // 서버 부하 방지를 위한 딜레이 (1초)
      if (completed < total) {
        await sleep(1000);
      }
    }

    statusEl.textContent = `✅ ${completed}개 파일 다운로드 완료!`;
    statusEl.className = 'spe-status spe-status-ok';

    // 새 PDF 수 갱신
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
    // 강의콘텐츠 페이지인지 확인
    if (!window.location.href.includes('external_tools')) return;

    // DOM 로딩 후 UI 삽입
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectUI);
    } else {
      injectUI();
    }
  }

  init();
})();
