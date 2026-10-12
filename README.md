# 3D Mind Map · obsidian-3d-mindmap

[English](#english) · [中文](#中文)

把 Markdown 大纲变成可编辑的三维思维导图。力导向计算由 Rust + WASM 在 Web Worker 中运行，**共 23 种布局**，运行时零网络请求。

---

<a id="中文"></a>

# 中文

## 特性

- **23 种布局**，含三种面向学习的组织方式：
  - **知识星座**：按章节形成独立星团，适合先看全貌，再聚焦概念
  - **章节书架**：章节分区，节点按 Markdown 阅读顺序排列，适合精读
  - **学习路径**：章节沿空间路线展开，适合顺序学习与复习
- **力导向计算**：Rust + WASM SIMD + Barnes–Hut 八叉树，运行在 Web Worker 中；
  一次只提交一个任务，使用可转移缓冲区回收内存
- **高效渲染**：普通节点批量绘制（3 次绘制调用覆盖 3000 节点），
  千节点以上按需创建标签并限制显示预算
- **重点标记**：球体自发光，亮度 0–4 连续可调，无光晕精灵、无选择外壳、无全屏 bloom
- **阅读辅助**：章节、主题和当前概念祖先标签优先；选中概念高亮真实父子路径；
  一键聚焦分支、返回全图、推荐阅读视角
- **备注**：支持 Markdown 与公式预览（`$E=mc^2$`、`$$…$$`）及 `[[笔记#标题|别名]]` 内链
- **背景**：保留主题与预设，新增就地编辑器，单色或双色竖向渐变，可预览后保存
- **可调节**：球径、节点间距、连线粗细、重点亮度均可连续调整

## 安装

将发行包中的 `main.js`、`manifest.json`、`styles.css`、`vendor/` 复制到：

```text
<你的 vault>/.obsidian/plugins/obsidian-3d-mindmap/
```

然后重载该插件。包中不含 `data.json`，升级会保留原有设置。

**运行本插件不需要 Rust、Node.js 或 npm** —— WASM 与 Worker 已内嵌进 `main.js`。

## 使用

1. 打开 Markdown 笔记，在命令面板执行「以 3D 思维导图打开当前笔记」
2. 「层级 → 展开与折叠」控制可见层级；「视角」选择自如旋转、绕选中点旋转或默认旋转
3. 选中节点，「编辑 → 节点操作 → 填写备注」；点「预览渲染」检查，
   点「保存备注」或 Ctrl+Enter 写回，Escape 撤销未保存内容
4. 「节点」组调整全局／选中球径、间距与重点亮度；「重点」钉住节点
5. 「背景 → 自定义单色／双色渐变」选择颜色，取消则不改动设置

「布局 → 知识学习」或「学习 → 阅读辅助」选择三种学习布局：
看全貌选**知识星座**，精读选**章节书架**，顺序复习选**学习路径**。

## 开发

需要 Node.js 20+、Rust stable、WASM target，Windows 上还需 MSVC 工具链。

```bash
npm ci
npm run build
npm test
```

`node scripts/build.mjs --js-only` 仅在 Rust 源码未改动时可用于界面开发。
详见 [`docs/environment.md`](./docs/environment.md)、[`docs/architecture.md`](./docs/architecture.md)。

## 卸载与回滚

回滚只需恢复本插件的 `main.js`、`styles.css`、`manifest.json` 与 `vendor/`，
并重载本插件。本插件不修改 Obsidian 的任何安全设置，也不覆盖其它插件。

## 源码来源与许可

原始 TypeScript 工程不可得，`src/recovered.js` 是从已安装构建产物恢复的可读源码，
保留原有构建符号与第三方依赖，未冒充丢失的 TS 原工程。
新功能集中在 `src/refresh.js`、`src/learning-layouts.js`、`src/rust-layout.js`、
`src/physics-worker.js`；Rust 内核在 `crates/graph-physics/`。

MIT 许可。引用代码保留各自的 MIT/ISC 声明，见 `LICENSE`、`licenses/` 与
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

> 原插件中的「键角／能级／轨道／晶格」等是布局的视觉原型，
> 不是分子、量子或晶体科学求解器。

---

<a id="english"></a>

# English

## Features

- **23 layouts**, including three study-oriented organizations:
  - **Knowledge constellation** — chapters as separated clusters; see the whole picture, then focus on a concept
  - **Chapter bookshelf** — chapter sections with nodes in Markdown reading order; for close reading
  - **Learning journey** — chapters laid out along a spatial route; for sequential study and review
- **Force simulation** — Rust + WASM SIMD + Barnes–Hut octree in a Web Worker;
  one outstanding task at a time, memory recycled through transferable buffers
- **Efficient rendering** — ordinary nodes batched into a single draw call
  (3 draw calls cover 3000 nodes); labels allocated on demand above a thousand nodes
- **Emphasis** — sphere emissive, brightness 0–4 continuously adjustable;
  no halo sprites, no selection shell, no full-screen bloom
- **Reading aids** — chapter, topic and ancestor labels take priority;
  selecting a concept highlights its real parent–child path;
  focus-branch, return-to-overview and recommended reading camera
- **Notes** — Markdown with formula preview (`$E=mc^2$`, `$$…$$`)
  and `[[note#heading|alias]]` internal links
- **Background** — themes and presets plus an in-place editor for solid or
  two-tone vertical gradients, previewed before saving
- **Continuous controls** — node radius, spacing, edge thickness and emphasis brightness

## Install

Copy `main.js`, `manifest.json`, `styles.css` and `vendor/` from the release archive into:

```text
<your vault>/.obsidian/plugins/obsidian-3d-mindmap/
```

Then reload the plugin. The archive contains no `data.json`, so upgrades keep your settings.

**Running this plugin requires no Rust, Node.js or npm** — the WASM module and worker
are embedded in `main.js`.

## Usage

1. Open a Markdown note and run “Open current note as 3D mind map” from the command palette
2. “Hierarchy → Expand and collapse” controls visible depth; “Viewpoint” picks free rotation,
   rotate-around-selection, or default rotation
3. Select a node and use “Edit → Node actions → Fill note”. Click “Preview render” to check,
   “Save note” or Ctrl+Enter to write back; Escape discards unsaved edits
4. The “Node” group adjusts global/selected radius, spacing and emphasis brightness;
   “Emphasis” pins a node
5. “Background → Custom solid / two-tone gradient” picks colors; cancelling changes nothing

“Layout → Knowledge learning” or “Learning → Reading aids” selects the three study layouts:
**Knowledge constellation** for overview, **Chapter bookshelf** for close reading,
**Learning journey** for sequential review.

## Development

Requires Node.js 20+, Rust stable and a WASM target; MSVC tooling on Windows.

```bash
npm ci
npm run build
npm test
```

`node scripts/build.mjs --js-only` is available for UI work when Rust sources are unchanged.
See [`docs/environment.md`](./docs/environment.md) and [`docs/architecture.md`](./docs/architecture.md).

## Uninstall and rollback

Rollback restores only this plugin's `main.js`, `styles.css`, `manifest.json` and `vendor/`,
then reloads it. The plugin changes no Obsidian security setting and overwrites no other plugin.

## Provenance and license

The original TypeScript project is unavailable. `src/recovered.js` is readable source
recovered from the installed build, retaining its original build symbols and third-party
dependencies; it does not impersonate the lost TypeScript project.
New functionality lives in `src/refresh.js`, `src/learning-layouts.js`, `src/rust-layout.js`
and `src/physics-worker.js`; the Rust core is in `crates/graph-physics/`.

MIT licensed. Referenced code keeps its own MIT/ISC notices — see `LICENSE`, `licenses/`
and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

> The original plugin's “bond angle / energy level / orbit / lattice” layouts are
> visual motifs, not molecular, quantum or crystallographic solvers.