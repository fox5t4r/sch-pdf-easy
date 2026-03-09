# SCH PDF Easy Downloader

순천향대학교 LMS(medlms.sch.ac.kr) 강의 PDF 자료를 **원클릭으로 다운로드**하는 Chrome 확장 프로그램입니다.

## 기능

- 📚 **한 번에 전체 스캔**: 강의콘텐츠 페이지에서 모든 주차의 PDF를 자동 탐색
- ⬇️ **새 파일만 다운로드**: 이미 받은 파일은 건너뛰고 새로 올라온 PDF만 다운로드
- 📦 **전체 다운로드**: 전체 PDF를 일괄 다운로드
- 📄 **개별 다운로드**: 원하는 파일만 선택 다운로드
- ✅ **다운로드 기록 관리**: 어떤 파일을 받았는지 자동 추적

## 설치 방법

### 개발자 모드로 설치

1. 이 저장소를 다운로드하거나 클론합니다:
   ```bash
   git clone https://github.com/fox5t4r/sch-pdf-easy.git
   ```
2. Chrome에서 `chrome://extensions/` 페이지를 엽니다.
3. 우측 상단의 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다** 버튼을 클릭합니다.
5. 다운로드한 `sch-pdf-easy` 폴더를 선택합니다.

## 사용 방법

1. LMS(medlms.sch.ac.kr)에 로그인합니다.
2. 원하는 과목의 **강의콘텐츠** 페이지에 들어갑니다.
3. 우측 하단에 나타나는 **📄 파란색 버튼**을 클릭합니다.
4. **스캔** 버튼으로 PDF 목록을 불러옵니다.
5. **새 PDF 다운로드** 또는 **전체 다운로드** 버튼을 클릭합니다.
6. 파일은 `다운로드/SCH_PDF/` 폴더에 저장됩니다.

## 작동 원리

```
medlms.sch.ac.kr (Canvas LMS)
  └─ iframe#tool_content (LTI CourseBuilder)
       └─ React + Redux Store
            └─ sections → subsections → units → components
                 └─ commons_content.content_id
                      └─ commons.sch.ac.kr/content.php API
                           └─ content_download_uri → PDF 다운로드
```

1. LTI iframe 내부 React 앱의 **Redux Store**에서 전체 강의 구조를 추출합니다.
2. 각 PDF 컴포넌트의 `content_id`를 사용하여 **commons.sch.ac.kr**의 content.php API를 호출합니다.
3. API 응답(XML)에서 `content_download_uri`를 파싱하여 다운로드 URL을 구성합니다.
4. Chrome Downloads API로 파일을 다운로드합니다.

## 파일 구조

```
sch-pdf-easy/
├── manifest.json      # Chrome 확장 프로그램 설정
├── background.js      # 다운로드 처리 (Service Worker)
├── content.js         # 메인 로직 (Redux 추출, UI, API 호출)
├── style.css          # UI 스타일
├── icons/             # 확장 프로그램 아이콘
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## 권한

| 권한 | 용도 |
|------|------|
| `activeTab` | 현재 탭의 LMS 페이지 접근 |
| `downloads` | PDF 파일 다운로드 |
| `storage` | 다운로드 기록 저장 |
| `host_permissions` | medlms.sch.ac.kr, commons.sch.ac.kr 접근 |

## 주의사항

- 순천향대학교 LMS 전용입니다.
- LMS에 로그인된 상태에서만 동작합니다.
- 교수님이 다운로드를 허용한 PDF만 다운로드됩니다 (서버 측 503 응답 시 건너뜀).

## 라이선스

MIT License
