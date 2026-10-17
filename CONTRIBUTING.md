# 贡献说明

欢迎通过 Issues 反馈问题，或提交小范围、便于验证的 Pull Request。

## 本地开发

```sh
npm ci
npx playwright install --with-deps chromium
npm test
```

运行用户脚本本身不依赖 Node；这里的依赖仅用于开发测试。

主要文件：

| 文件 | 用途 |
| --- | --- |
| `bili-lyrics.user.js` | 自包含的浏览器用户脚本 |
| `install.html` | 内置完整源码的备用安装页 |
| `tools/build-installer.cjs` | 将最新源码同步到安装页 |
| `tests/core.test.cjs` | 签名、时间与文件格式验证 |
| `tests/browser.test.cjs` | Playwright 交互与错误流程验证 |
| `tests/fixture.html` | 不使用真实账号或字幕的测试页面 |

## 提交前

1. 修改脚本后运行 `npm run build:installer`，一并提交更新后的 `install.html`。
2. 运行 `npm test`。
3. 行为有变化时更新 README；发布版本时同步脚本头部、`package.json`、锁文件与 CHANGELOG 的版本。
4. 测试中保持接口数据可控；真实登录态和账号数据不属于测试夹具。

## 问题反馈

请提供浏览器与篡改猴版本、脚本版本、视频 URL / 分 P、复现步骤、预期结果和实际提示。如果包含截图，请标出面板所在位置。
