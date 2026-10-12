# 开发环境要求

> 本文档描述构建本插件**需要什么**。任何机器上的具体安装路径、工具版本缓存位置
> 和个人配置都不应写入本仓库。

## 构建工具链

| 工具 | 版本要求 | 用途 |
| --- | --- | --- |
| Node.js | 20+ | 构建脚本、测试、格式化 |
| Rust stable | 1.99+ | `crates/graph-physics` 内核 |
| wasm-pack | 0.13+ | 生成 WASM 绑定 |
| MSVC 工具链 | Windows 构建时需要 | Rust 编译目标 |

```bash
npm ci
npm run build
npm test
```

### 说明

- WASM 与 Worker 会被**内嵌进 `main.js`**。终端用户运行本插件不需要 Rust、Node.js 或 npm。
- `node scripts/build.mjs --js-only` 仅在 Rust 源码未改动、且 `pkg/` 中已有最新产物时
  可用于界面开发，以缩短迭代时间。
- `crates/graph-physics/pkg/` 是 wasm-pack 的产物目录，已被 `.gitignore` 忽略；
  需要通过 `npm run build` 重新生成。

## 运行期

- 插件不发起网络请求，不在运行时下载代码。
- 不修改 Obsidian 的任何安全设置。
- 不覆盖其它已安装插件；安装与回滚只涉及本插件目录。
- 回滚只恢复本插件的 `main.js`、`styles.css`、`manifest.json` 与 `vendor/`，
  并重载本插件。与构建工具的卸载是两件独立的事。

## 第三方依赖

运行时依赖（Three.js、KaTeX、d3-force-3d）已内嵌于发布产物中。
构建期依赖记录在 `package-lock.json`，Rust 依赖记录在 `Cargo.lock`。
完整归属见 `THIRD_PARTY_NOTICES.md` 与 `licenses/`。

**私人 vault 的笔记、备份目录与任何凭据都不进入源码包与发行包。**
打包脚本 `scripts/package.py` 使用白名单收件，并在打包后断言不存在
`_tmp/` 前缀、`node_modules/` 前缀或 `data.json`。