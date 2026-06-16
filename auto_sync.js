/**
 * SCH PDF Easy Downloader - Login Auto Sync Trigger
 *
 * medlms.sch.ac.kr에 로그인된 페이지가 열리면 background에 전체 과목 자동
 * 스캔/다운로드 시작을 요청합니다. 실제 다운로드 대상 선정과 권한 검증은
 * background.js에서 수행합니다.
 */

(function () {
  'use strict';

  function isLikelyLoggedIn() {
    if (!location.hostname.endsWith('medlms.sch.ac.kr')) return false;
    if (document.querySelector('form[action*="login"], input[type="password"]')) return false;
    return !!(
      document.cookie ||
      document.querySelector('a[href*="/logout"], a[href*="logout"]') ||
      document.querySelector('[href*="/courses/"]') ||
      location.pathname.includes('/courses')
    );
  }

  function requestAutoDownload() {
    if (!isLikelyLoggedIn()) return;
    chrome.runtime.sendMessage({ action: 'maybeStartAutoDownload' }, () => {
      // background가 cooldown/설정/진행 중 여부를 판단하므로 응답은 로깅하지 않는다.
      void chrome.runtime.lastError;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', requestAutoDownload, { once: true });
  } else {
    requestAutoDownload();
  }
})();
