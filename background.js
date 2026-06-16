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
const AUTO_DOWNLOAD_COOLDOWN_MS = 10 * 60 * 1000;
const AUTO_DOWNLOAD_COURSE_LIMIT = 100;
const AUTO_DOWNLOAD_DEFAULT_CONCURRENCY = 2;
const _pendingStartedDownloads = new Map();
const PENDING_DOWNLOADS_KEY = 'pendingStartedDownloads';
let _autoDownloadRun = null;
const _autoScanTabs = new Set();

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
    chrome.storage.local.get({ downloadConcurrency: 5, autoDownloadOnLogin: true }, (data) => {
      const downloadConcurrency = Shared.normalizeDownloadConcurrency(data.downloadConcurrency, 5, 8);
      sendResponse({
        success: true,
        downloadConcurrency,
        autoDownloadOnLogin: data.autoDownloadOnLogin !== false,
      });
    });
    return true;
  }

  if (message.action === 'maybeStartAutoDownload') {
    maybeStartAutoDownload()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'autoDownloadCandidates') {
    autoDownloadCandidates(message.pdfs)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'getAutoDownloadState') {
    chrome.storage.local.get({
      autoDownloadOnLogin: true,
      autoDownloadLastStartedAt: 0,
      autoDownloadLastNoCourseAt: 0,
      autoDownloadLastSummary: null,
    }, (data) => {
      sendResponse({
        success: true,
        running: !!_autoDownloadRun,
        autoDownloadOnLogin: data.autoDownloadOnLogin !== false,
        autoDownloadLastStartedAt: data.autoDownloadLastStartedAt || 0,
        autoDownloadLastNoCourseAt: data.autoDownloadLastNoCourseAt || 0,
        autoDownloadLastSummary: data.autoDownloadLastSummary || null,
      });
    });
    return true;
  }

  if (message.action === 'autoCoursePageScanDone') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null && _autoScanTabs.has(tabId)) {
      _autoScanTabs.delete(tabId);
      chrome.tabs.remove(tabId, () => {
        void chrome.runtime.lastError;
      });
    }
    sendResponse({ success: true });
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
  const candidates = DownloadUtils.resolveCommonsDownloadUrlCandidatesFromXml
    ? DownloadUtils.resolveCommonsDownloadUrlCandidatesFromXml(xmlText, pdf)
    : [DownloadUtils.resolveCommonsDownloadUrlFromXml(xmlText, pdf)];
  const resolvedUrl = await chooseNonEmptyDownloadUrl(candidates, pdf);
  const allowedUrl = Shared.resolveAllowedDownloadUrl(resolvedUrl);
  if (!allowedUrl) throw new Error('Blocked: untrusted resolved URL');
  return allowedUrl;
}

async function chooseNonEmptyDownloadUrl(candidates, pdf) {
  let lastError = null;
  for (let url of candidates) {
    if (!url) continue;
    if (pdf.type !== 'lx_resource') {
      url = DownloadUtils.appendFileNameParam(url, pdf.title);
    }
    const allowedUrl = Shared.resolveAllowedDownloadUrl(url);
    if (!allowedUrl) continue;
    try {
      const usable = await isLikelyNonEmptyDownloadUrl(allowedUrl);
      if (usable) return allowedUrl;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  throw new Error('No non-empty download URL candidate');
}

async function isLikelyNonEmptyDownloadUrl(url) {
  const response = await fetch(url, {
    method: 'HEAD',
    credentials: 'include',
    redirect: 'follow',
  });
  if (response.status === 405 || response.status === 501) return true;
  if (!response.ok) return false;
  const contentLength = response.headers.get('content-length');
  if (contentLength != null && Number(contentLength) === 0) return false;
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) return false;
  return true;
}

async function maybeStartAutoDownload() {
  const settings = await chrome.storage.local.get({
    autoDownloadOnLogin: true,
    autoDownloadLastStartedAt: 0,
    autoDownloadLastNoCourseAt: 0,
    downloadConcurrency: AUTO_DOWNLOAD_DEFAULT_CONCURRENCY,
  });

  if (settings.autoDownloadOnLogin === false) {
    return { success: true, skipped: true, reason: 'auto download disabled' };
  }

  if (_autoDownloadRun) {
    return { success: true, skipped: true, reason: 'already running' };
  }

  const now = Date.now();
  if (now - Number(settings.autoDownloadLastStartedAt || 0) < AUTO_DOWNLOAD_COOLDOWN_MS) {
    return { success: true, skipped: true, reason: 'cooldown' };
  }
  if (now - Number(settings.autoDownloadLastNoCourseAt || 0) < 30000) {
    return { success: true, skipped: true, reason: 'no course retry cooldown' };
  }

  const concurrency = Shared.normalizeDownloadConcurrency(
    settings.downloadConcurrency,
    AUTO_DOWNLOAD_DEFAULT_CONCURRENCY,
    3
  );

  _autoDownloadRun = runAutoDownloadAllCourses(concurrency)
    .catch((err) => {
      console.warn('[SCH PDF Easy] 자동 다운로드 실패:', err);
      return { success: false, error: err.message };
    })
    .finally(() => {
      _autoDownloadRun = null;
    });

  return { success: true, started: true };
}

async function runAutoDownloadAllCourses(concurrency) {
  const downloadedFiles = await getDownloadedFiles();
  const courses = await fetchCourses();
  const candidates = [];

  if (courses.length === 0) {
    await chrome.storage.local.set({
      autoDownloadLastNoCourseAt: Date.now(),
      autoDownloadLastSummary: {
        checkedAt: new Date().toISOString(),
        state: 'no-current-courses',
        courseCount: 0,
        candidateCount: 0,
        downloadCount: 0,
      },
    });
    return { success: true, courseCount: 0, downloadCount: 0 };
  }

  await chrome.storage.local.set({ autoDownloadLastStartedAt: Date.now() });

  await scanCoursebuilderPages(courses);

  for (const course of courses.slice(0, AUTO_DOWNLOAD_COURSE_LIMIT)) {
    try {
      const [canvasFiles, lxResources] = await Promise.all([
        fetchCanvasFileCandidates(course),
        fetchLearningXResourceCandidates(course),
      ]);
      candidates.push(...canvasFiles, ...lxResources);
    } catch (err) {
      console.debug('[SCH PDF Easy] 자동 다운로드 과목 스캔 실패:', course.id, err.message);
    }
  }

  const unique = Shared.mergeUniqueByContentId(candidates)
    .map((candidate) => Shared.normalizeDownloadCandidate(candidate))
    .filter((candidate) => {
      if (!candidate || downloadedFiles[candidate.contentId]) return false;
      return Shared.getAvailabilityStatus(candidate.availability).downloadable !== false;
    });

  await chrome.storage.local.set({
    autoDownloadLastSummary: {
      checkedAt: new Date().toISOString(),
      state: 'completed',
      courseCount: courses.length,
      candidateCount: candidates.length,
      downloadCount: unique.length,
    },
  });

  await runWithConcurrency(unique, concurrency, autoDownloadSingle);
  return { success: true, courseCount: courses.length, downloadCount: unique.length };
}

async function autoDownloadCandidates(rawCandidates) {
  const candidates = Array.isArray(rawCandidates) ? rawCandidates : [];
  const downloadedFiles = await getDownloadedFiles();
  const targets = Shared.mergeUniqueByContentId(candidates)
    .map((candidate) => Shared.normalizeDownloadCandidate(candidate))
    .filter((candidate) => {
      if (!candidate || downloadedFiles[candidate.contentId]) return false;
      return Shared.getAvailabilityStatus(candidate.availability).downloadable !== false;
    });

  if (targets.length === 0) {
    return { success: true, started: false, downloadCount: 0 };
  }

  const settings = await chrome.storage.local.get({ downloadConcurrency: AUTO_DOWNLOAD_DEFAULT_CONCURRENCY });
  const concurrency = Shared.normalizeDownloadConcurrency(
    settings.downloadConcurrency,
    AUTO_DOWNLOAD_DEFAULT_CONCURRENCY,
    3
  );

  await chrome.storage.local.set({
    autoDownloadLastSummary: {
      checkedAt: new Date().toISOString(),
      state: 'current-page-candidates',
      courseCount: null,
      candidateCount: candidates.length,
      downloadCount: targets.length,
    },
  });

  await runWithConcurrency(targets, concurrency, autoDownloadSingle);
  return { success: true, started: true, downloadCount: targets.length };
}

async function scanCoursebuilderPages(courses) {
  const targets = courses.slice(0, AUTO_DOWNLOAD_COURSE_LIMIT);
  await chrome.storage.local.set({
    autoDownloadLastSummary: {
      checkedAt: new Date().toISOString(),
      state: 'coursebuilder-tab-scan',
      courseCount: targets.length,
      candidateCount: 0,
      downloadCount: 0,
    },
  });

  for (const course of targets) {
    await scanCoursebuilderPage(course);
  }
}

function scanCoursebuilderPage(course) {
  return new Promise((resolve) => {
    const url = `${DownloadUtils.MEDLMS_BASE}/courses/${encodeURIComponent(course.id)}/external_tools/1#spe-auto-download`;
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab || tab.id == null) {
        resolve();
        return;
      }

      const tabId = tab.id;
      _autoScanTabs.add(tabId);
      const timeoutId = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(onDone);
        if (_autoScanTabs.has(tabId)) {
          _autoScanTabs.delete(tabId);
          chrome.tabs.remove(tabId, () => {
            void chrome.runtime.lastError;
          });
        }
        resolve();
      }, 45000);

      function onDone(message, sender) {
        if (!message || message.action !== 'autoCoursePageScanDone') return;
        if (!sender || !sender.tab || sender.tab.id !== tabId) return;
        chrome.runtime.onMessage.removeListener(onDone);
        clearTimeout(timeoutId);
        resolve();
      }

      chrome.runtime.onMessage.addListener(onDone);
    });
  });
}

function getDownloadedFiles() {
  return chrome.storage.local.get('downloadedFiles').then((data) => data.downloadedFiles || {});
}

async function fetchCourses() {
  let favorites = [];
  try {
    favorites = await fetchPaginatedJson('/api/v1/users/self/favorites/courses?per_page=100');
  } catch (err) {
    console.debug('[SCH PDF Easy] 즐겨찾기 과목 조회 실패:', err.message);
  }
  const filterCourses = Shared.filterCurrentStudentCourses ||
    ((courses) => courses.filter((course) => course && course.id));
  const filteredFavorites = filterCourses(favorites);
  if (filteredFavorites.length > 0) return filteredFavorites;

  const active = await fetchPaginatedJson('/api/v1/courses?enrollment_state=active&per_page=100');
  return filterCourses(active);
}

async function fetchCanvasFileCandidates(course) {
  const files = await fetchPaginatedJson(
    `/api/v1/courses/${encodeURIComponent(course.id)}/files?` +
      'content_types[]=application/pdf' +
      '&content_types[]=application/vnd.ms-powerpoint' +
      '&content_types[]=application/vnd.openxmlformats-officedocument.presentationml.presentation' +
      '&per_page=100&sort=created_at&order=desc'
  );

  return files
    .filter((file) => file && file.id && file.url)
    .map((file) => {
      const fname = file.display_name || file.filename || '';
      const ext = Shared.getSupportedExtFromName(fname) || 'pdf';
      return {
        title: `${course.name || course.course_code || 'course'} - ${fname.replace(/\.(pdf|pptx?)$/i, '') || 'untitled'}`,
        contentId: `cf_${file.id}`,
        section: course.name || course.course_code || '강의자료',
        subsection: '자동 다운로드',
        type: 'canvas_file',
        ext,
        directUrl: file.url,
        availability: Shared.normalizeAvailability(file),
      };
    });
}

async function fetchLearningXResourceCandidates(course) {
  const endpoints = [
    `/learningx/api/v1/courses/${encodeURIComponent(course.id)}/resources`,
    `/learningx/api/v1/courses/${encodeURIComponent(course.id)}/resources_db`,
  ];
  let resources = [];
  for (const endpoint of endpoints) {
    try {
      resources = await fetchJsonArray(endpoint);
      if (resources.length > 0) break;
    } catch (err) {
      console.debug('[SCH PDF Easy] LearningX API 스캔 실패:', endpoint, err.message);
    }
  }

  return resources
    .map((resource) => buildLearningXCandidate(course, resource))
    .filter(Boolean);
}

function buildLearningXCandidate(course, resource) {
  const commons = resource && resource.commons_content;
  if (!commons || !commons.content_id) return null;

  const ext = Shared.getSupportedExtFromName(commons.file_name || resource.title || '') ||
    Shared.getSupportedExtFromName('file.' + (commons.content_type || ''));
  if (!ext) return null;

  return {
    title: `${course.name || course.course_code || 'course'} - ${resource.title || commons.file_name || commons.content_name || 'untitled'}`,
    contentId: extractThumbnailUUID(commons.thumbnail_url) || resource.xn_id || resource.resource_id || commons.content_id,
    lxContentId: commons.content_id,
    section: course.name || course.course_code || '강의자료실',
    subsection: '자동 다운로드',
    type: 'lx_resource',
    ext,
    availability: mergeAvailability(resource, commons),
  };
}

function mergeAvailability(primary, secondary) {
  const first = Shared.normalizeAvailability(primary) || {};
  const second = Shared.normalizeAvailability(secondary) || {};
  const merged = {
    unlockAt: first.unlockAt || second.unlockAt || null,
    lockAt: first.lockAt || second.lockAt || null,
    locked: !!(first.locked || second.locked),
    hidden: !!(first.hidden || second.hidden),
  };
  return Shared.normalizeAvailability({ availability: merged });
}

function extractThumbnailUUID(thumbnailUrl) {
  const match = String(thumbnailUrl || '').match(/contents\/([^.?/]+)/);
  return match ? match[1] : null;
}

async function fetchPaginatedJson(url) {
  const results = [];
  let nextUrl = toMedlmsUrl(url);
  while (nextUrl) {
    const response = await fetch(nextUrl, { credentials: 'include' });
    if (response.status === 401 || response.status === 403) return results;
    if (!response.ok) throw new Error(`API request failed: ${response.status}`);

    const data = await parseProtectedJsonResponse(response);
    const arr = Array.isArray(data) ? data : (data.courses || data.resources || data.items || data.data || []);
    if (Array.isArray(arr)) results.push(...arr);
    const nextLink = Shared.getNextLinkFromHeader(response.headers.get('Link'));
    nextUrl = nextLink ? toMedlmsUrl(nextLink) : null;
  }
  return results;
}

async function fetchJsonArray(url) {
  const response = await fetch(toMedlmsUrl(url), { credentials: 'include' });
  if (response.status === 401 || response.status === 403) return [];
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  const data = await parseProtectedJsonResponse(response);
  const arr = Array.isArray(data) ? data : (data.resources || data.items || data.data || []);
  return Array.isArray(arr) ? arr : [];
}

function toMedlmsUrl(url) {
  return new URL(url, DownloadUtils.MEDLMS_BASE).toString();
}

async function parseProtectedJsonResponse(response) {
  const text = await response.text();
  const cleanText = Shared.stripJsonProtectionPrefix
    ? Shared.stripJsonProtectionPrefix(text)
    : String(text || '').replace(/^\s*while\s*\(\s*1\s*\)\s*;\s*/, '');
  return JSON.parse(cleanText);
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      try {
        await worker(item);
      } catch (err) {
        console.debug('[SCH PDF Easy] 자동 다운로드 항목 실패:', item && item.title, err.message);
      }
    }
  }));
}

async function autoDownloadSingle(pdf) {
  const downloadUrl = await resolveDownloadUrl(pdf);
  const safeTitle = Shared.sanitizeFilename(pdf.title, 'download');
  const filename = `${safeTitle}.${pdf.ext || 'pdf'}`;
  const downloadId = await chrome.downloads.download({
    url: downloadUrl,
    filename: `SCH_PDF/${filename}`,
    conflictAction: 'uniquify',
  });

  await rememberPendingDownload(downloadId, {
    contentId: pdf.contentId,
    title: pdf.title,
    tabId: null,
  });
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
