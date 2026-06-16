/**
 * SCH PDF Easy Downloader - Login Auto Sync Trigger
 *
 * medlms.sch.ac.kr에 로그인된 페이지가 열리면 background에 전체 과목 자동
 * 스캔/다운로드 시작을 요청합니다. 실제 다운로드 대상 선정과 권한 검증은
 * background.js에서 수행합니다.
 */

(function () {
  'use strict';

  function isLoginPage() {
    if (!location.hostname.endsWith('medlms.sch.ac.kr')) return false;
    if (/\/login\b/i.test(location.pathname)) return true;
    return !!document.querySelector('form[action*="login"], input[type="password"]');
  }

  function requestAutoDownload() {
    if (!location.hostname.endsWith('medlms.sch.ac.kr') || isLoginPage()) return;
    chrome.runtime.sendMessage({ action: 'maybeStartAutoDownload' }, (response) => {
      if (response) console.debug('[SCH PDF Easy] 로그인 자동 백업 요청:', response);
      void chrome.runtime.lastError;
    });
  }

  function scheduleAutoDownloadRequests() {
    requestAutoDownload();
    setTimeout(requestAutoDownload, 2000);
    setTimeout(requestAutoDownload, 8000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleAutoDownloadRequests, { once: true });
  } else {
    scheduleAutoDownloadRequests();
  }
})();
