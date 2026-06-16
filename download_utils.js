(function (root, factory) {
  const api = factory(root.SpeShared || (typeof require === 'function' ? require('./shared.js') : null));
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.SpeDownloadUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Shared) {
  'use strict';

  const COMMONS_BASE = 'https://commons.sch.ac.kr';
  const MEDLMS_BASE = 'https://medlms.sch.ac.kr';
  const CONTENT_API = COMMONS_BASE + '/viewer/ssplayer/uniplayer_support/content.php';

  function decodeXmlText(text) {
    return String(text || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function extractXmlTag(xmlText, tagName) {
    const escaped = String(tagName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('<' + escaped + '[^>]*>([\\s\\S]*?)<\\/' + escaped + '>', 'i');
    const match = String(xmlText || '').match(re);
    return match ? decodeXmlText(match[1].trim()) : '';
  }

  function buildContentApiUrl(contentId, timestamp) {
    return CONTENT_API + '?content_id=' + encodeURIComponent(contentId) + '&_=' + encodeURIComponent(timestamp || Date.now());
  }

  function buildFallbackCommonsDownloadUrl(contentId, ext) {
    const safeExt = Shared && Shared.isSupportedExt && Shared.isSupportedExt(ext) ? ext : 'pdf';
    const fileSubpath = encodeURIComponent('contents\\web_files\\original.' + safeExt);
    return COMMONS_BASE + '/index.php?module=xn_media_content2013&act=dispXn_media_content2013DownloadWebFile&site_id=sch1000001&content_id=' +
      encodeURIComponent(contentId) + '&web_storage_id=301&file_subpath=' + fileSubpath;
  }

  function appendFileNameParam(url, title) {
    const separator = String(url).includes('?') ? '&' : '?';
    return url + separator + 'file_name=' + encodeURIComponent(title || 'download');
  }

  function resolveDirectUrl(directUrl) {
    if (!Shared || !Shared.resolveAllowedDownloadUrl) return null;
    return Shared.resolveAllowedDownloadUrl(directUrl, MEDLMS_BASE);
  }

  function resolveCommonsDownloadUrlFromXml(xmlText, pdf) {
    const effectiveContentId = pdf.type === 'lx_resource' && pdf.lxContentId ? pdf.lxContentId : pdf.contentId;
    return buildFallbackCommonsDownloadUrl(effectiveContentId, pdf.ext || 'pdf');
  }

  function resolveCommonsDownloadUrlCandidatesFromXml(xmlText, pdf) {
    const fixedUrl = Shared.resolveAllowedDownloadUrl(resolveCommonsDownloadUrlFromXml(xmlText, pdf));
    return fixedUrl ? [fixedUrl] : [];
  }

  return {
    COMMONS_BASE,
    CONTENT_API,
    MEDLMS_BASE,
    appendFileNameParam,
    buildContentApiUrl,
    buildFallbackCommonsDownloadUrl,
    extractXmlTag,
    resolveCommonsDownloadUrlCandidatesFromXml,
    resolveCommonsDownloadUrlFromXml,
    resolveDirectUrl,
  };
});
