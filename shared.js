(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.SpeShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ALLOWED_DOWNLOAD_HOSTS = ['medlms.sch.ac.kr', 'commons.sch.ac.kr'];
  const SUPPORTED_EXTS = ['pdf', 'ppt', 'pptx'];
  const MAX_FILENAME_LENGTH = 180;

  function mergeUniqueByContentId() {
    const seen = new Set();
    const merged = [];

    for (let i = 0; i < arguments.length; i++) {
      const list = Array.isArray(arguments[i]) ? arguments[i] : [];
      for (const item of list) {
        if (!item || !item.contentId || seen.has(item.contentId)) continue;
        seen.add(item.contentId);
        merged.push(item);
      }
    }

    return merged;
  }

  function shouldRefreshLxCache(cache, courseId) {
    if (!courseId) return !cache || !Array.isArray(cache.resources);
    return !cache || cache.courseId !== courseId || !Array.isArray(cache.resources);
  }

  function buildLxResourceEntry(params) {
    if (!params || !params.lxContentId) return null;
    return {
      title: params.title || '',
      contentId: params.contentId,
      lxContentId: params.lxContentId,
      section: params.section || '',
      subsection: params.subsection || '',
      type: 'lx_resource',
      ext: params.ext || 'pdf',
    };
  }

  function getNextLinkFromHeader(linkHeader) {
    if (!linkHeader || typeof linkHeader !== 'string') return null;
    const parts = linkHeader.split(',');
    for (const part of parts) {
      const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
      if (match && match[2] === 'next') {
        return match[1];
      }
    }
    return null;
  }

  function isDownloadResponseSuccess(response) {
    return !!(response && response.success);
  }

  function isSupportedExt(ext) {
    return SUPPORTED_EXTS.includes(String(ext || '').toLowerCase());
  }

  function getSupportedExtFromName(name) {
    const lower = String(name || '').toLowerCase();
    for (const ext of SUPPORTED_EXTS) {
      if (lower.endsWith('.' + ext)) return ext;
    }
    return null;
  }

  function createRequestId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'spe_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
  }

  function isAllowedDownloadUrl(url, baseUrl) {
    try {
      const parsed = baseUrl ? new URL(url, baseUrl) : new URL(url);
      return parsed.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.includes(parsed.hostname);
    } catch (e) {
      return false;
    }
  }

  function resolveAllowedDownloadUrl(url, baseUrl) {
    try {
      const parsed = baseUrl ? new URL(url, baseUrl) : new URL(url);
      if (parsed.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.includes(parsed.hostname)) return null;
      return parsed.toString();
    } catch (e) {
      return null;
    }
  }

  function sanitizeFilename(name, fallback) {
    let safe = String(name || '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\.\.+/g, '_')
      .replace(/_+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, '');

    if (!safe || /^_+$/.test(safe)) safe = fallback || 'download';
    if (safe.length > MAX_FILENAME_LENGTH) safe = safe.slice(0, MAX_FILENAME_LENGTH).trim();
    return safe || (fallback || 'download');
  }

  function normalizeDownloadConcurrency(value, fallback, max) {
    const defaultValue = fallback || 5;
    const maxValue = max || 8;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 1) return defaultValue;
    return Math.min(maxValue, Math.floor(numeric));
  }

  function normalizeDownloadCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;

    const title = String(candidate.title || '').trim() || 'untitled';
    const contentId = String(candidate.contentId || '').trim();
    const ext = String(candidate.ext || 'pdf').toLowerCase();
    const type = String(candidate.type || 'commons');

    if (!contentId || contentId.length > 256 || !isSupportedExt(ext)) return null;

    const normalized = {
      title: title.slice(0, 300),
      contentId,
      section: String(candidate.section || '').slice(0, 200),
      subsection: String(candidate.subsection || '').slice(0, 200),
      type,
      ext,
    };

    if (candidate.lxContentId != null) {
      const lxContentId = String(candidate.lxContentId || '').trim();
      if (lxContentId && lxContentId.length <= 256) normalized.lxContentId = lxContentId;
    }

    if (candidate.directUrl != null) {
      const directUrl = String(candidate.directUrl || '').trim();
      if (!directUrl || directUrl.length > 2048 || directUrl.startsWith('//')) return null;
      if (!directUrl.startsWith('/') && !isAllowedDownloadUrl(directUrl)) return null;
      normalized.directUrl = directUrl;
    }

    return normalized;
  }

  function redactIdentifier(value) {
    const text = String(value || '');
    if (!text) return '';
    if (text.length <= 8) return '[redacted]';
    return text.slice(0, 6) + '…redacted';
  }

  function redactUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(String(value), 'https://medlms.sch.ac.kr');
      return url.origin + url.pathname.replace(/\d{3,}/g, '[id]') + (url.search ? '?[redacted]' : '');
    } catch (e) {
      return '[redacted-url]';
    }
  }

  return {
    ALLOWED_DOWNLOAD_HOSTS,
    SUPPORTED_EXTS,
    buildLxResourceEntry,
    createRequestId,
    getNextLinkFromHeader,
    getSupportedExtFromName,
    isAllowedDownloadUrl,
    isDownloadResponseSuccess,
    isSupportedExt,
    mergeUniqueByContentId,
    normalizeDownloadCandidate,
    normalizeDownloadConcurrency,
    redactIdentifier,
    redactUrl,
    resolveAllowedDownloadUrl,
    sanitizeFilename,
    shouldRefreshLxCache,
  };
});
