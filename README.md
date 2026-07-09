# 豆包导出助手

豆包导出助手是一个 Chrome Manifest V3 扩展，用于在浏览器本地将当前豆包网页对话导出为 `Markdown`、`HTML`、`JSON` 和 `TXT`。

## Current Scope

- Current conversation export to `Markdown`
- Current conversation export to `HTML`
- Current conversation export to `JSON`
- Current conversation export to `TXT`
- Optional message timestamps
- Optional date range filtering
- Automatic split export for large conversations
- Network-first capture with DOM fallback
- Free release with no activation code

## Project Structure

- `src/manifest.json`: MV3 manifest
- `src/content.js`: core UI, capture, normalization, export logic
- `src/styles/dialog.css`: ChatShell-inspired floating dialog UI
- `src/icons/*`: extension icons reused from the ChatShell reference repository
- `docs/index.html`: GitHub Pages landing page
- `docs/privacy.html`: privacy policy page
- `docs/chrome-web-store-review.md`: Chrome Web Store review checklist
- `docs/store-listing.zh-CN.md`: Chinese store listing draft

## How To Load

1. Open `chrome://extensions/`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Run `npm run build`
5. Select the `dist` directory in this project
6. Open a Doubao web conversation page
7. Click the floating shell button on the right edge

## Export Behavior

### Current Conversation

- Prefers structured messages captured from page requests
- Falls back to visible DOM messages if network data is unavailable

### Large Conversations

- Refreshes the current conversation before export when needed
- Splits large exports automatically to reduce browser download failures

## Notes

- This extension is for logged-in Doubao web pages
- Export processing runs locally in the browser
- The extension does not upload conversation data to a server
- Runtime behavior on real Doubao pages still depends on actual request shapes and DOM structure

## Local Checks

```bash
npm test
npm run check
npm run build
```
