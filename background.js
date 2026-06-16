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

  if (message.action === 'downloadPDF') {
    handleDownload(message, sendResponse);
    return true; // async response
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
