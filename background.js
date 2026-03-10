/**
 * SCH PDF Easy Downloader - Background Service Worker
 *
 * content.js에서 받은 PDF/PPT 다운로드 요청을 처리합니다.
 * chrome.downloads API는 background에서만 사용 가능합니다.
 */

// 스토리지 쓰기 직렬화: 동시 다운로드 완료 시 read-modify-write 경쟁 방지
let _writeQueue = Promise.resolve();

function recordDownload(contentId, title, callback) {
  _writeQueue = _writeQueue.then(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.get('downloadedFiles', (data) => {
          const files = data.downloadedFiles || {};
          files[contentId] = { title, downloadedAt: new Date().toISOString() };
          chrome.storage.local.set({ downloadedFiles: files }, () => {
            if (callback) callback();
            resolve();
          });
        });
      })
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

async function handleDownload(message, sendResponse) {
  const { url, filename, contentId, title } = message;

  try {
    const downloadId = await chrome.downloads.download({
      url: url,
      filename: `SCH_PDF/${filename}`,
      conflictAction: 'uniquify',
    });

    // 다운로드 완료/실패 감지
    chrome.downloads.onChanged.addListener(function listener(delta) {
      if (delta.id !== downloadId || !delta.state) return;

      const state = delta.state.current;
      if (state === 'complete') {
        chrome.downloads.onChanged.removeListener(listener);
        recordDownload(contentId, title);
        sendResponse({ success: true, downloadId });
      } else if (state === 'interrupted' || state === 'cancelled') {
        // 'cancelled' 도 리스너 해제 — 이전 버전에서 누락되어 리스너 누적 발생
        chrome.downloads.onChanged.removeListener(listener);
        sendResponse({ success: false, error: `Download ${state}` });
      }
    });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}
