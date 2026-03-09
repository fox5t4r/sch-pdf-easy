/**
 * SCH PDF Easy Downloader - Background Service Worker
 *
 * content.js에서 받은 PDF 다운로드 요청을 처리합니다.
 * chrome.downloads API는 background에서만 사용 가능합니다.
 */

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
    chrome.storage.local.get('downloadedFiles', (data) => {
      const files = data.downloadedFiles || {};
      files[message.contentId] = {
        title: message.title,
        downloadedAt: new Date().toISOString()
      };
      chrome.storage.local.set({ downloadedFiles: files }, () => {
        sendResponse({ success: true });
      });
    });
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
      conflictAction: 'uniquify'
    });

    // 다운로드 완료 감지
    chrome.downloads.onChanged.addListener(function listener(delta) {
      if (delta.id === downloadId && delta.state) {
        if (delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          // 다운로드 완료 기록
          chrome.storage.local.get('downloadedFiles', (data) => {
            const files = data.downloadedFiles || {};
            files[contentId] = {
              title: title,
              downloadedAt: new Date().toISOString()
            };
            chrome.storage.local.set({ downloadedFiles: files });
          });
          sendResponse({ success: true, downloadId });
        } else if (delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          sendResponse({ success: false, error: 'Download interrupted' });
        }
      }
    });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}
