# Hui Music Radio

本地 localhost �?AI 音乐电台：React PWA + Node.js + SQLite + OpenAI + QQ/LX 导入 + LX 音源播放地址解析�?
## 快速开�?
1. 复制 `.env.example` �?`.env`，填�?`OPENAI_API_KEY`�?2. 运行 `npm run dev`�?3. 打开 `http://127.0.0.1:3000`�?
前端开发也可以运行 `npm run dev:client`，Vite 会把 `/api` �?`/cache` 代理到后端�?
## 约束

- 只面向本�?localhost，API key 不会发到浏览器�?- LX 公益源只做单�?URL 解析，服务端带缓存和串行限流，避免短时间批量请求�?- QQ 音乐歌单解析依赖公开页面/接口，若平台改动会返回可恢复错误；LX 列表导入不受影响�?- 默认文本模型�?`claude-haiku-4-5`，可以在 `.env` �?`OPENAI_TEXT_MODEL` 调整�?
## 常用命令

- `npm run dev`：启动后端并托管生产构建后的前端；开发时若没�?`dist`，会提示使用 Vite�?- `npm run dev:client`：启�?Vite 前端开发服务器�?- `npm test`：运行单元和集成测试�?- `npm run build`：构建前端并类型检查服务端�?