(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.SpeShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

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

  return {
    buildLxResourceEntry,
    getNextLinkFromHeader,
    isDownloadResponseSuccess,
    mergeUniqueByContentId,
    shouldRefreshLxCache,
  };
});
