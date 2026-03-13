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
  // 자기 확장에서 온 메시지만 허용
  if (sender.id !== chrome.runtime.id) return;

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

const ALLOWED_DOWNLOAD_HOSTS = ['medlms.sch.ac.kr', 'commons.sch.ac.kr'];
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5분

async function handleDownload(message, sendResponse) {
  const { url, filename, contentId, title } = message;

  // URL 도메인 화이트리스트 검증
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' ||
        !ALLOWED_DOWNLOAD_HOSTS.some(d => parsed.hostname === d)) {
      sendResponse({ success: false, error: 'Blocked: untrusted URL' });
      return;
    }
  } catch (e) {
    sendResponse({ success: false, error: 'Invalid URL' });
    return;
  }

  // filename 경로 탈출 방지
  const safeName = filename.replace(/\.\./g, '_').replace(/^\/+/, '');

  try {
    const downloadId = await chrome.downloads.download({
      url: url,
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
      if (delta.id !== downloadId || !delta.state) return;

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
