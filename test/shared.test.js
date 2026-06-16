const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLxResourceEntry,
  filterCurrentStudentCourses,
  getAvailabilityStatus,
  getNextLinkFromHeader,
  isAllowedDownloadUrl,
  isDownloadResponseSuccess,
  mergeUniqueByContentId,
  normalizeAvailability,
  normalizeDownloadCandidate,
  normalizeDownloadConcurrency,
  redactIdentifier,
  redactUrl,
  resolveAllowedDownloadUrl,
  sanitizeFilename,
  shouldRefreshLxCache,
  stripJsonProtectionPrefix,
} = require('../shared.js');

const {
  appendFileNameParam,
  buildFallbackCommonsDownloadUrl,
  extractXmlTag,
  resolveCommonsDownloadUrlFromXml,
} = require('../download_utils.js');

test('mergeUniqueByContentId keeps first item for duplicated content ids', () => {
  const merged = mergeUniqueByContentId(
    [
      { contentId: 'a', title: 'first-a' },
      { contentId: 'b', title: 'first-b' },
    ],
    [
      { contentId: 'b', title: 'second-b' },
      { contentId: 'c', title: 'second-c' },
    ]
  );

  assert.deepEqual(merged, [
    { contentId: 'a', title: 'first-a' },
    { contentId: 'b', title: 'first-b' },
    { contentId: 'c', title: 'second-c' },
  ]);
});

test('shouldRefreshLxCache detects course changes and missing caches', () => {
  assert.equal(shouldRefreshLxCache(null, '101'), true);
  assert.equal(shouldRefreshLxCache({ courseId: '101', resources: [] }, '101'), false);
  assert.equal(shouldRefreshLxCache({ courseId: '101', resources: [] }, '202'), true);
  assert.equal(shouldRefreshLxCache({ courseId: '101', resources: null }, '101'), true);
});

test('buildLxResourceEntry skips unresolved lx resources', () => {
  assert.equal(
    buildLxResourceEntry({
      title: 'Lecture 1',
      contentId: 'thumb-id',
      lxContentId: null,
      ext: 'pdf',
    }),
    null
  );

  assert.deepEqual(
    buildLxResourceEntry({
      title: 'Lecture 1',
      contentId: 'thumb-id',
      lxContentId: 'commons-id',
      section: '강의자료실',
      subsection: '',
      ext: 'pdf',
    }),
    {
      title: 'Lecture 1',
      contentId: 'thumb-id',
      lxContentId: 'commons-id',
      section: '강의자료실',
      subsection: '',
      type: 'lx_resource',
      ext: 'pdf',
    }
  );
});

test('getNextLinkFromHeader extracts the next page URL', () => {
  const linkHeader =
    '<https://medlms.sch.ac.kr/api/v1/courses/1/files?page=2>; rel="next", ' +
    '<https://medlms.sch.ac.kr/api/v1/courses/1/files?page=3>; rel="last"';

  assert.equal(
    getNextLinkFromHeader(linkHeader),
    'https://medlms.sch.ac.kr/api/v1/courses/1/files?page=2'
  );
  assert.equal(getNextLinkFromHeader(null), null);
});

test('isDownloadResponseSuccess only accepts explicit success responses', () => {
  assert.equal(isDownloadResponseSuccess({ success: true }), true);
  assert.equal(isDownloadResponseSuccess({ success: false, error: 'Download interrupted' }), false);
  assert.equal(isDownloadResponseSuccess(undefined), false);
});

test('download URL allowlist only permits HTTPS LMS/Commons targets', () => {
  assert.equal(isAllowedDownloadUrl('https://medlms.sch.ac.kr/files/1'), true);
  assert.equal(isAllowedDownloadUrl('https://commons.sch.ac.kr/files/1'), true);
  assert.equal(isAllowedDownloadUrl('/files/1', 'https://medlms.sch.ac.kr'), true);
  assert.equal(isAllowedDownloadUrl('http://medlms.sch.ac.kr/files/1'), false);
  assert.equal(isAllowedDownloadUrl('https://evil.example/files/1'), false);
  assert.equal(resolveAllowedDownloadUrl('/files/1', 'https://medlms.sch.ac.kr'), 'https://medlms.sch.ac.kr/files/1');
});

test('sanitizeFilename removes path traversal and invalid filename characters', () => {
  assert.equal(sanitizeFilename('../bad/name?.pdf'), '_bad_name_.pdf');
  assert.equal(sanitizeFilename('  ...  ', 'download.pdf'), 'download.pdf');
  assert.equal(sanitizeFilename('lecture\u0000 name.pptx'), 'lecture_ name.pptx');
});

test('normalizeDownloadCandidate rejects invalid scan results', () => {
  assert.equal(normalizeDownloadCandidate({ title: 'x', contentId: '', ext: 'pdf' }), null);
  assert.equal(normalizeDownloadCandidate({ title: 'x', contentId: '1', ext: 'exe' }), null);
  assert.equal(normalizeDownloadCandidate({ title: 'x', contentId: '1', ext: 'pdf', directUrl: 'javascript:alert(1)' }), null);
  assert.deepEqual(
    normalizeDownloadCandidate({ title: 'x', contentId: '1', ext: 'pdf', directUrl: '/files/1' }),
    { title: 'x', contentId: '1', section: '', subsection: '', type: 'commons', ext: 'pdf', directUrl: '/files/1' }
  );
});

test('normalizeAvailability maps LMS availability metadata', () => {
  assert.deepEqual(
    normalizeAvailability({
      unlock_at: '2026-06-16T01:00:00+09:00',
      lock_at: '2026-06-20T23:59:00+09:00',
      locked_for_user: 'false',
      hidden: 0,
    }),
    {
      unlockAt: '2026-06-15T16:00:00.000Z',
      lockAt: '2026-06-20T14:59:00.000Z',
      locked: false,
      hidden: false,
    }
  );
  assert.equal(normalizeAvailability({ title: 'no availability' }), null);
});

test('getAvailabilityStatus only marks currently accessible resources downloadable', () => {
  const now = Date.parse('2026-06-16T00:00:00.000Z');

  assert.deepEqual(
    getAvailabilityStatus({ lockAt: '2026-06-16T06:00:00.000Z' }, now),
    { state: 'ending-soon', label: '6시간 남음', downloadable: true, urgency: 3 }
  );
  assert.equal(
    getAvailabilityStatus({ lockAt: '2026-06-15T23:59:59.000Z' }, now).downloadable,
    false
  );
  assert.equal(
    getAvailabilityStatus({ unlockAt: '2026-06-17T00:00:00.000Z' }, now).state,
    'upcoming'
  );
  assert.equal(
    getAvailabilityStatus({ locked: true }, now).state,
    'restricted'
  );
});

test('normalizeDownloadCandidate preserves valid availability policy metadata', () => {
  assert.deepEqual(
    normalizeDownloadCandidate({
      title: 'x',
      contentId: '1',
      ext: 'pdf',
      lock_at: '2026-06-20T00:00:00.000Z',
    }),
    {
      title: 'x',
      contentId: '1',
      section: '',
      subsection: '',
      type: 'commons',
      ext: 'pdf',
      availability: {
        unlockAt: null,
        lockAt: '2026-06-20T00:00:00.000Z',
        locked: false,
        hidden: false,
      },
    }
  );
});

test('diagnostic redaction masks identifiers and URL query strings', () => {
  assert.equal(redactIdentifier('abcdef1234567890'), 'abcdef…redacted');
  assert.equal(redactIdentifier('short'), '[redacted]');
  assert.equal(
    redactUrl('https://medlms.sch.ac.kr/courses/49561/external_tools/1?token=secret'),
    'https://medlms.sch.ac.kr/courses/[id]/external_tools/1?[redacted]'
  );
});

test('download utils parse XML and build extension-aware fallback URLs', () => {
  const xml = '<root><content_download_uri>/download.php?a=1&amp;b=2</content_download_uri></root>';
  assert.equal(extractXmlTag(xml, 'content_download_uri'), '/download.php?a=1&b=2');
  assert.equal(
    resolveCommonsDownloadUrlFromXml(xml, { contentId: 'cid', ext: 'pdf', type: 'commons' }),
    'https://commons.sch.ac.kr/download.php?a=1&b=2'
  );

  assert.match(buildFallbackCommonsDownloadUrl('cid', 'pdf'), /original\.pdf/);
  assert.match(buildFallbackCommonsDownloadUrl('cid', 'ppt'), /original\.ppt/);
  assert.match(buildFallbackCommonsDownloadUrl('cid', 'pptx'), /original\.pptx/);
  assert.equal(
    appendFileNameParam('https://commons.sch.ac.kr/download.php?a=1', '강의 1'),
    'https://commons.sch.ac.kr/download.php?a=1&file_name=%EA%B0%95%EC%9D%98%201'
  );
});


test('normalizeDownloadConcurrency clamps invalid and excessive values', () => {
  assert.equal(normalizeDownloadConcurrency(undefined, 5, 8), 5);
  assert.equal(normalizeDownloadConcurrency('0', 5, 8), 5);
  assert.equal(normalizeDownloadConcurrency('3', 5, 8), 3);
  assert.equal(normalizeDownloadConcurrency(10, 5, 8), 8);
  assert.equal(normalizeDownloadConcurrency(4.7, 5, 8), 4);
});

test('stripJsonProtectionPrefix removes Canvas XSSI guards', () => {
  assert.equal(stripJsonProtectionPrefix('while(1);[{"id":1}]'), '[{"id":1}]');
  assert.equal(stripJsonProtectionPrefix('for(;;);{"ok":true}'), '{"ok":true}');
});

test('filterCurrentStudentCourses prefers active on-campus student courses', () => {
  const now = Date.parse('2026-06-16T00:00:00.000Z');
  const courses = [
    {
      id: 50105,
      name: '2026학년도 맛있는SW시리즈',
      workflow_state: 'available',
      end_at: '2026-06-26T14:59:00Z',
      enrollments: [{ type: 'student', role: 'StudentEnrollment', enrollment_state: 'active' }],
    },
    {
      id: 49561,
      name: '알고리즘(13563)',
      workflow_state: 'available',
      course_format: 'on_campus',
      enrollments: [{ type: 'student', role: 'StudentEnrollment', enrollment_state: 'active' }],
    },
    {
      id: 49000,
      name: '지난 강의',
      workflow_state: 'available',
      course_format: 'on_campus',
      end_at: '2026-01-01T00:00:00Z',
      enrollments: [{ type: 'student', role: 'StudentEnrollment', enrollment_state: 'active' }],
    },
  ];

  assert.deepEqual(
    filterCurrentStudentCourses(courses, now).map((course) => course.id),
    [49561]
  );
});
