# SCH PDF Easy Downloader

Chrome extension for bulk-downloading lecture PDFs and PPTs from Soonchunhyang University LMS ([medlms.sch.ac.kr](https://medlms.sch.ac.kr)).

![Screenshot](./screenshot.png)

---

## Features

- **Two page types supported**
  - 강의콘텐츠 (`external_tools/1`) — scans React/Redux state for attached files
  - 강의자료실 (`external_tools/2`) — falls back to DOM scanning when Redux is unavailable
- **Three file sources detected**
  - LTI commons content (PDF/PPT viewer embeds)
  - Canvas page attachments (`<a class="description_file_attachment">`)
  - Direct file uploads (various component structures)
- **PDF and PPT/PPTX** both supported
- **5 concurrent downloads** with live progress bar
- **Download history** — distinguishes new files from already-downloaded ones, persisted across sessions
- Skips already-downloaded files unless you explicitly use 전체 다운로드

---

## Installation

No build step required.

1. Go to the [Releases](https://github.com/fox5t4r/sch-pdf-easy/releases) page and download the latest zip
2. Unzip it
3. Open Chrome → `chrome://extensions` → enable **Developer mode**
4. Click **Load unpacked** and select the unzipped folder

Or clone and load directly:

```bash
git clone https://github.com/fox5t4r/sch-pdf-easy.git
```

---

## Usage

1. Log in to [medlms.sch.ac.kr](https://medlms.sch.ac.kr) and navigate to a course's **강의콘텐츠** or **강의자료실** page
2. Click the **PDF** button in the bottom-right corner — the panel opens and auto-scans
3. Click **새 파일** to download only undownloaded files, or **전체** to download everything
4. Files are saved to `Downloads/SCH_PDF/`

If the scan fails on the first try, click the **스캔** button to retry manually.

---

## Project Structure

```
sch-pdf-easy/
├── manifest.json      # MV3 manifest — permissions, content script config
├── background.js      # Service worker — chrome.downloads, chrome.storage
├── content.js         # Isolated world — UI panel, scan orchestration, download logic
├── injector.js        # MAIN world — React Fiber traversal, Redux store access, DOM fallback
├── style.css          # Extension UI styles
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

**Architecture overview:**

```
content.js  ──(CustomEvent '__SPE_SCAN_REQUEST')──▶  injector.js
                                                         │
                                              coursebuilder: Redux store
                                              courseresource: DOM scan
                                                         │
content.js  ◀─(CustomEvent '__SPE_SCAN_RESULT')──────────┘
    │
    ├─ merge with Canvas File API results
    └─ send download requests ──▶ background.js ──▶ chrome.downloads
```

---

## Permissions

| Permission | Purpose |
|---|---|
| `downloads` | Save files to `Downloads/SCH_PDF/` |
| `storage` | Persist download history across sessions |
| `activeTab` | Access the current LMS tab's DOM |
| `medlms.sch.ac.kr/*` | Scan lecture pages, call Canvas File API |
| `commons.sch.ac.kr/*` | Fetch download URLs from the commons content API |

---

## Notes

- Only works on Soonchunhyang University LMS. You must be logged in.
- Only downloads files the server permits — server-side access restrictions are respected.

## License

MIT
