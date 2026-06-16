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

  function stripJsonProtectionPrefix(text) {
    return String(text || '')
      .replace(/^\s*while\s*\(\s*1\s*\)\s*;\s*/, '')
      .replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
  }

  function hasActiveStudentEnrollment(course) {
    const enrollments = course && Array.isArray(course.enrollments) ? course.enrollments : [];
    return enrollments.some((enrollment) => {
      const state = String(enrollment.enrollment_state || '').toLowerCase();
      const type = String(enrollment.type || '').toLowerCase();
      const role = String(enrollment.role || '').toLowerCase();
      return state === 'active' && (type === 'student' || role === 'studentenrollment');
    });
  }

  function isWithinCourseDates(course, now) {
    const nowMs = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Number(now));
    const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const startMs = course && course.start_at ? new Date(course.start_at).getTime() : null;
    const endMs = course && course.end_at ? new Date(course.end_at).getTime() : null;

    if (startMs && currentMs < startMs) return false;
    if (endMs && currentMs > endMs) return false;
    return true;
  }

  function filterCurrentStudentCourses(courses, now) {
    const list = Array.isArray(courses) ? courses : [];
    const active = list.filter((course) => {
      if (!course || !course.id) return false;
      if (course.workflow_state && course.workflow_state !== 'available') return false;
      if (!hasActiveStudentEnrollment(course)) return false;
      return isWithinCourseDates(course, now);
    });

    const onCampus = active.filter((course) => course.course_format === 'on_campus');
    return onCampus.length > 0 ? onCampus : active;
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function firstDefined(source, keys) {
    if (!source || typeof source !== 'object') return undefined;
    for (const key of keys) {
      if (hasOwn(source, key) && source[key] != null && source[key] !== '') return source[key];
    }
    return undefined;
  }

  function normalizeDateValue(value) {
    if (value == null || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  function normalizeBoolean(value) {
    if (value === true || value === false) return value;
    if (typeof value === 'string') {
      const lower = value.trim().toLowerCase();
      if (lower === 'true' || lower === '1' || lower === 'yes') return true;
      if (lower === 'false' || lower === '0' || lower === 'no') return false;
    }
    if (typeof value === 'number') return value !== 0;
    return false;
  }

  function normalizeAvailability(source) {
    const raw = source && source.availability && typeof source.availability === 'object'
      ? source.availability
      : source;
    if (!raw || typeof raw !== 'object') return null;

    const unlockAtRaw = firstDefined(raw, [
      'unlockAt',
      'unlock_at',
      'availableFrom',
      'available_from',
      'available_at',
      'openAt',
      'open_at',
      'startAt',
      'start_at',
    ]);
    const lockAtRaw = firstDefined(raw, [
      'lockAt',
      'lock_at',
      'availableUntil',
      'available_until',
      'closeAt',
      'close_at',
      'endAt',
      'end_at',
      'dueAt',
      'due_at',
    ]);
    const lockedRaw = firstDefined(raw, [
      'locked',
      'lockedForUser',
      'locked_for_user',
      'isLocked',
      'is_locked',
      'restricted',
    ]);
    const hiddenRaw = firstDefined(raw, [
      'hidden',
      'isHidden',
      'is_hidden',
      'unpublished',
      'is_unpublished',
    ]);

    const unlockAt = normalizeDateValue(unlockAtRaw);
    const lockAt = normalizeDateValue(lockAtRaw);
    const locked = normalizeBoolean(lockedRaw);
    const hidden = normalizeBoolean(hiddenRaw);

    if (!unlockAt && !lockAt && !locked && !hidden) return null;

    return {
      unlockAt,
      lockAt,
      locked,
      hidden,
    };
  }

  function formatDateLabel(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
  }

  function getAvailabilityStatus(availability, now) {
    const normalized = normalizeAvailability(availability);
    const nowMs = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Number(now));
    const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();

    if (!normalized) {
      return { state: 'available', label: '접근 가능', downloadable: true, urgency: 0 };
    }
    if (normalized.hidden || normalized.locked) {
      return { state: 'restricted', label: '접근 제한', downloadable: false, urgency: 0 };
    }

    const unlockAtMs = normalized.unlockAt ? new Date(normalized.unlockAt).getTime() : null;
    const lockAtMs = normalized.lockAt ? new Date(normalized.lockAt).getTime() : null;

    if (unlockAtMs && currentMs < unlockAtMs) {
      return { state: 'upcoming', label: formatDateLabel(normalized.unlockAt) + ' 공개 예정', downloadable: false, urgency: 0 };
    }
    if (lockAtMs && currentMs > lockAtMs) {
      return { state: 'expired', label: '기간 종료', downloadable: false, urgency: 0 };
    }
    if (lockAtMs && currentMs <= lockAtMs) {
      const remainingMs = lockAtMs - currentMs;
      const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
      const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
      if (remainingHours <= 24) {
        return {
          state: 'ending-soon',
          label: Math.max(1, remainingHours) + '시간 남음',
          downloadable: true,
          urgency: 3,
        };
      }
      if (remainingDays <= 3) {
        return {
          state: 'ending-soon',
          label: Math.max(1, remainingDays) + '일 남음',
          downloadable: true,
          urgency: 2,
        };
      }
      return {
        state: 'available-until',
        label: formatDateLabel(normalized.lockAt) + '까지',
        downloadable: true,
        urgency: 1,
      };
    }

    return { state: 'available', label: '접근 가능', downloadable: true, urgency: 0 };
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

    const availability = normalizeAvailability(candidate);
    if (availability) normalized.availability = availability;

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
    getAvailabilityStatus,
    isAllowedDownloadUrl,
    isDownloadResponseSuccess,
    isSupportedExt,
    mergeUniqueByContentId,
    normalizeAvailability,
    normalizeDownloadCandidate,
    normalizeDownloadConcurrency,
    redactIdentifier,
    redactUrl,
    resolveAllowedDownloadUrl,
    sanitizeFilename,
    shouldRefreshLxCache,
    filterCurrentStudentCourses,
    stripJsonProtectionPrefix,
  };
});
