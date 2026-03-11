const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLxResourceEntry,
  getNextLinkFromHeader,
  isDownloadResponseSuccess,
  mergeUniqueByContentId,
  shouldRefreshLxCache,
} = require('../shared.js');

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
