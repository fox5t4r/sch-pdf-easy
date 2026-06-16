/**
 * SCH PDF Easy Downloader - Background Service Worker
 *
 * content.js에서 받은 PDF/PPT 다운로드 요청을 처리합니다.
 * chrome.downloads API와 cross-origin fetch는 background에서만 수행합니다.
 */

if (typeof importScripts === 'function') {
  importScripts('shared.js', 'download_utils.js');
}

const Shared = globalThis.SpeShared;
const DownloadUtils = globalThis.SpeDownloadUtils;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5분
const _pendingStartedDownloads = new Map();
const PENDING_DOWNLOADS_KEY = 'pendingStartedDownloads';

// 스토리지 쓰기 직렬화: 동시 다운로드 완료 시 read-modify-write 경쟁 방지
let _writeQueue = Promise.resolve();

function recordDownload(contentId, title, callback) {
  const safeContentId = String(contentId || '').trim();
  if (!safeContentId) {
    if (callback) callback();
    return;
  }

  _writeQueue = _writeQueue.then(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.get('downloadedFiles', (data) => {
          const files = data.downloadedFiles || {};
          files[safeContentId] = {
            title: String(title || '').slice(0, 300),
            downloadedAt: new Date().toISOString(),
          };
          chrome.storage.local.set({ downloadedFiles: files }, () => {
            if (callback) callback();
            resolve();
          });
        });
      })
  ).catch((err) => {
    console.warn('[SCH PDF Easy] 다운로드 기록 저장 실패:', err);
    if (callback) callback();
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 자기 확장에서 온 메시지만 허용
  if (sender.id !== chrome.runtime.id) return;

  if (message.action === 'resolveDownloadUrl') {
    resolveDownloadUrl(message.pdf)
      .then((url) => sendResponse({ success: true, url }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'startDownloadPDF') {
    startDownload(message, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }

  if (message.action === 'downloadPDF') {
    handleDownload(message, sendResponse);
    return true; // async response
  }

  if (message.action === 'getSettings') {
    chrome.storage.local.get({ downloadConcurrency: 5 }, (data) => {
      const downloadConcurrency = Shared.normalizeDownloadConcurrency(data.downloadConcurrency, 5, 8);
      sendResponse({ success: true, downloadConcurrency });
    });
    return true;
  }

  if (message.action === 'getDownloaded') {
    chrome.storage.local.get('downloadedFiles', (data) => {
      sendResponse(data.downloadedFiles || {});
    });
    return true;
  }

  if (message.action === 'markDownloaded') {
    recordDownload(message.contentId, message.title, () => sendResponse({ success: true }));
    return true;
  }

  if (message.action === 'clearDownloaded') {
    chrome.storage.local.set({ downloadedFiles: {} }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

async function resolveDownloadUrl(rawPdf) {
  const pdf = Shared.normalizeDownloadCandidate(rawPdf);
  if (!pdf) throw new Error('Invalid download metadata');

  if (pdf.directUrl) {
    const directUrl = DownloadUtils.resolveDirectUrl(pdf.directUrl);
    if (!directUrl) throw new Error('Blocked: untrusted direct URL');
    return directUrl;
  }

  const effectiveContentId = pdf.type === 'lx_resource' && pdf.lxContentId
    ? pdf.lxContentId
    : pdf.contentId;

  const apiUrl = DownloadUtils.buildContentApiUrl(effectiveContentId);
  const response = await fetch(apiUrl, { credentials: 'include' });
  if (!response.ok) throw new Error(`Content metadata request failed: ${response.status}`);

  const xmlText = await response.text();
  let resolvedUrl = DownloadUtils.resolveCommonsDownloadUrlFromXml(xmlText, pdf);

  // 기존 commons 자료는 file_name 파라미터로 브라우저 저장명을 보정한다.
  if (pdf.type !== 'lx_resource') {
    resolvedUrl = DownloadUtils.appendFileNameParam(resolvedUrl, pdf.title);
  }

  const allowedUrl = Shared.resolveAllowedDownloadUrl(resolvedUrl);
  if (!allowedUrl) throw new Error('Blocked: untrusted resolved URL');
  return allowedUrl;
}


async function startDownload(message, sender) {
  const { url, filename, contentId, title } = message;

  const allowedUrl = Shared.resolveAllowedDownloadUrl(url);
  if (!allowedUrl) return { success: false, error: 'Blocked: untrusted URL' };

  const safeName = Shared.sanitizeFilename(filename, 'download.pdf');
  const downloadId = await chrome.downloads.download({
    url: allowedUrl,
    filename: `SCH_PDF/${safeName}`,
    conflictAction: 'uniquify',
  });

  await rememberPendingDownload(downloadId, {
    contentId: String(contentId || '').trim(),
    title: String(title || '').slice(0, 300),
    tabId: sender && sender.tab ? sender.tab.id : null,
  });

  return { success: true, downloadId, started: true };
}

function getPendingDownloads(callback) {
  chrome.storage.local.get(PENDING_DOWNLOADS_KEY, (data) => {
    callback(data[PENDING_DOWNLOADS_KEY] || {});
  });
}

function setPendingDownloads(pending, callback) {
  chrome.storage.local.set({ [PENDING_DOWNLOADS_KEY]: pending }, callback || (() => {}));
}

function rememberPendingDownload(downloadId, pending) {
  _pendingStartedDownloads.set(downloadId, pending);
  return new Promise((resolve) => {
    getPendingDownloads((allPending) => {
      allPending[downloadId] = pending;
      setPendingDownloads(allPending, resolve);
    });
  });
}

function forgetPendingDownload(downloadId) {
  _pendingStartedDownloads.delete(downloadId);
  getPendingDownloads((allPending) => {
    delete allPending[downloadId];
    setPendingDownloads(allPending);
  });
}

function notifyDownloadStatus(downloadId, status, error, pending) {
  if (!pending) return;

  if (status === 'complete') {
    recordDownload(pending.contentId, pending.title);
  }

  if (status === 'complete' || status === 'interrupted' || status === 'cancelled') {
    forgetPendingDownload(downloadId);
  }

  if (pending.tabId == null) return;
  chrome.tabs.sendMessage(
    pending.tabId,
    {
      action: 'downloadStatusChanged',
      downloadId,
      contentId: pending.contentId,
      title: pending.title,
      status,
      error: error || '',
    },
    () => {
      // content script가 이미 사라진 경우 lastError가 발생할 수 있으므로 무시한다.
      void chrome.runtime.lastError;
    }
  );
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const state = delta.state.current;
  if (state !== 'complete' && state !== 'interrupted' && state !== 'cancelled') return;

  const pending = _pendingStartedDownloads.get(delta.id);
  if (pending) {
    notifyDownloadStatus(delta.id, state, state === 'complete' ? '' : `Download ${state}`, pending);
    return;
  }

  // MV3 service worker가 다운로드 중 종료됐다가 onChanged로 다시 깨어난 경우를 위해
  // storage에 저장한 pending map에서 복구한다.
  getPendingDownloads((allPending) => {
    const restored = allPending[delta.id];
    if (restored) {
      notifyDownloadStatus(delta.id, state, state === 'complete' ? '' : `Download ${state}`, restored);
    }
  });
});

async function handleDownload(message, sendResponse) {
  const { url, filename, contentId, title } = message;

  const allowedUrl = Shared.resolveAllowedDownloadUrl(url);
  if (!allowedUrl) {
    sendResponse({ success: false, error: 'Blocked: untrusted URL' });
    return;
  }

  const safeName = Shared.sanitizeFilename(filename, 'download.pdf');

  try {
    const downloadId = await chrome.downloads.download({
      url: allowedUrl,
      filename: `SCH_PDF/${safeName}`,
      conflictAction: 'uniquify',
    });

    // 다운로드 완료/실패 감지 (timeout 포함)
    let responded = false;
    const timer = setTimeout(() => {
      if (!responded) {
        responded = true;
        chrome.downloads.onChanged.removeListener(listener);
        sendResponse({ success: false, error: 'Download timeout' });
      }
    }, DOWNLOAD_TIMEOUT_MS);

    function listener(delta) {
      if (responded || delta.id !== downloadId || !delta.state) return;

      const state = delta.state.current;
      if (state === 'complete') {
        clearTimeout(timer);
        responded = true;
        chrome.downloads.onChanged.removeListener(listener);
        recordDownload(contentId, title);
        sendResponse({ success: true, downloadId });
      } else if (state === 'interrupted' || state === 'cancelled') {
        clearTimeout(timer);
        responded = true;
        chrome.downloads.onChanged.removeListener(listener);
        sendResponse({ success: false, error: `Download ${state}` });
      }
    }

    chrome.downloads.onChanged.addListener(listener);
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}
