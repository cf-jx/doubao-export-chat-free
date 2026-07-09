# Chrome Web Store 发布审阅清单

日期：2026-07-09

## 当前结论

豆包导出助手 1.0.0 按免费版发布。发布包应使用 `npm run build` 生成的 `dist`，不要使用混淆包。扩展只做当前豆包网页对话的本地导出，不提供账号同步、不上传聊天数据、不加载远程代码。

## 代码与包

- Manifest 使用 MV3：`manifest_version: 3`。
- `package.json` 和 `src/manifest.json` 版本保持 `1.0.0`。
- Chrome Web Store 上传 ZIP 根目录必须直接包含 `manifest.json`。
- 不提交混淆代码；Chrome 官方允许压缩，但禁止混淆。
- 不从 GitHub Raw、CDN 或远程接口加载 JS、WASM、模板逻辑或规则逻辑。
- 不保留收费版入口、旧收费工具或个人联系方式硬编码。

## 权限

- `storage`：保存导出设置、缓存和运行状态。
- `downloads`：触发用户导出文件下载。
- `unlimitedStorage`：支持大对话、图片和分片导出的本地缓存。
- `host_permissions` 仅限豆包域名：`doubao.com`、`www.doubao.com`、`*.doubao.com`。
- 不使用 `<all_urls>`、`tabs`、`cookies`、`webRequest` 等更宽权限。

## 隐私

- Privacy tab 应声明不收集用户数据。
- 隐私政策应说明：数据仅在当前浏览器本地处理；导出文件由用户保存；扩展不上传聊天记录到服务器。
- 商店描述、隐私政策、扩展关于页和实际行为必须一致。
- 不在描述区放隐私政策全文链接替代 Dashboard 隐私政策字段。

## 商品详情页

- 只做中文资料。
- 名称：豆包导出助手。
- 一句话说明：在浏览器本地将豆包网页对话导出为 Markdown、HTML、JSON 或 TXT。
- 分类建议：Workflow & Planning 或 Productivity。
- 截图建议用真实扩展面板，不使用模糊、变形或夸大营销图。
- 不写“官方”“第一”“最佳”等无法证明或容易误导的表述。

## GitHub Pages

- 使用 `docs/` 作为静态页源。
- 建议 URL：`https://cf-jx.github.io/doubao-export-chat/`。
- 隐私政策 URL：`https://cf-jx.github.io/doubao-export-chat/privacy.html`。
- GitHub Pages 只是展示和隐私政策承载，不能替代 Chrome Web Store 的 Privacy tab、权限说明和测试说明。

## 官方来源

- Chrome Web Store review process: https://developer.chrome.com/docs/webstore/review-process
- Prepare extension: https://developer.chrome.com/docs/webstore/prepare
- Publish extension: https://developer.chrome.com/docs/webstore/publish
- Update extension: https://developer.chrome.com/docs/webstore/update
- Manifest reference: https://developer.chrome.com/docs/extensions/reference/manifest
- Manifest version: https://developer.chrome.com/docs/extensions/reference/manifest/version
- Program policies: https://developer.chrome.com/docs/webstore/program-policies/policies
- Limited Use policy: https://developer.chrome.com/docs/webstore/program-policies/limited-use
- Privacy practices: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Permissions policy: https://developer.chrome.com/docs/webstore/program-policies/permissions
- Remote hosted code migration: https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
- Troubleshooting violations: https://developer.chrome.com/docs/webstore/troubleshooting
