import { RustLayout } from './rust-layout.js';
import { LEARNING_LAYOUTS, LEARNING_KINDS, placeLearning, placeTidyTree, placeWeightedRadial, separateNodes } from './learning-layouts.js';

const VERSION = '1.17.0';

export function installRefresh(api) {
  const { Layout, Scene, Renderer, Labels, View, Plugin, THREE, obsidian, openMenu, closeMenu, button } = api;
  for (const item of LEARNING_LAYOUTS) {
    if (!api.layoutKinds.includes(item.id)) api.layoutKinds.push(item.id);
    api.layoutNames[item.id] = item.name; api.layoutHints[item.id] = item.hint;
  }
  api.layoutGroups.unshift({ title: '知识学习', kinds: LEARNING_LAYOUTS.map(x => x.id) });
  Object.assign(api.layoutHints, {
    radial: '按分支体量分配扇区，按层级展开；适合读从属关系。',
    tree: '父节点位于后代上方，叶节点紧凑分区；适合读结构。',
    bond: '有方向的分支树，适合探索概念间的层级。视觉原型。',
    pennate: '沿主轴展开分支，适合展示主线与旁支。视觉原型。',
    rdf: '按层级分壳，适合概览知识深度。视觉原型。',
    shell: '不同层级占不同壳层，适合比较宽度和深度。视觉原型。',
    orbital: '沿多个方向展布，适合辨认主分支。视觉原型。',
    coil: '曲线串联的空间结构，适合探索长链条。视觉原型。',
    lattice: '规则格点展开，适合查看密集知识节点。视觉原型。',
  });
  const originalPrepare = Layout.prototype.prepare;
  const originalStop = Layout.prototype.stop;
  Layout.prototype.stop = function () {
    this.rust?.dispose(); this.rust = null; this.transition = null; originalStop.call(this);
  };
  Layout.prototype.prepare = function (kind, nodes, links, warm = true) {
    this.stop();
    if (kind !== 'force' || !nodes.length || typeof Worker === 'undefined') {
      this.backend = 'javascript';
      const starts = nodes.map(n => ({ x: n.x, y: n.y, z: n.z }));
      if (LEARNING_KINDS.has(kind) || kind === 'tree' || kind === 'radial') {
        this.kind = kind; this.nodes = nodes; this.lastLinks = links;
        if (LEARNING_KINDS.has(kind)) placeLearning(kind, nodes, this.opts);
        else if (kind === 'tree') placeTidyTree(nodes, this.opts);
        else placeWeightedRadial(nodes, this.opts);
      } else originalPrepare.call(this, kind, nodes, links, warm);
      if (kind !== 'force') separateNodes(nodes, this.opts);
      if (kind !== 'force' && warm && nodes.length) {
        this.transition = { starts, targets: nodes.map(n => ({ x: n.x, y: n.y, z: n.z })), start: performance.now() };
        nodes.forEach((n, i) => Object.assign(n, starts[i]));
      }
      return;
    }
    this.kind = kind; this.nodes = nodes; this.lastLinks = links;
    this.backend = 'rust-wasm';
    this.rust = new RustLayout(this, nodes, links, message => {
      this.rust = null; this.backend = 'javascript-fallback'; this.backendError = message;
      originalPrepare.call(this, kind, nodes, links, true);
      new obsidian.Notice('Rust 布局暂不可用，已切回 JavaScript。详情见控制台。');
    });
  };
  const originalStep = Layout.prototype.step, originalReheat = Layout.prototype.reheat;
  Layout.prototype.step = function () {
    if (this.transition) {
      const t = this.transition, progress = Math.min(1, (performance.now() - t.start) / 320);
      const ease = 1 - (1 - progress) ** 3;
      this.nodes.forEach((n, i) => { for (const axis of ['x', 'y', 'z']) n[axis] = t.starts[i][axis] + (t.targets[i][axis] - t.starts[i][axis]) * ease; });
      if (progress === 1) this.transition = null;
      return 1 - progress;
    }
    return this.rust ? this.rust.step() : originalStep.call(this);
  };
  Layout.prototype.reheat = function (alpha) { return this.rust ? this.rust.reheat() : originalReheat.call(this, alpha); };
  const active = Object.getOwnPropertyDescriptor(Layout.prototype, 'active').get;
  Object.defineProperty(Layout.prototype, 'active', { get() { return !!this.transition || (this.rust ? this.rust.active : active.call(this)); } });
  const alpha = Object.getOwnPropertyDescriptor(Layout.prototype, 'alpha').get;
  Object.defineProperty(Layout.prototype, 'alpha', { get() { return this.rust ? (this.rust.active ? .1 : 0) : alpha.call(this); } });
  const originalFreeze = Layout.prototype.freeze, originalCool = Layout.prototype.cool;
  Layout.prototype.freeze = function (id, fixed) { originalFreeze.call(this, id, fixed); this.rust?.reheat(); };
  Layout.prototype.cool = function () { originalCool.call(this); if (this.rust) this.rust.active = false; };

  // Keep original mesh records for picking, notes and diagnostics; render ordinary
  // nodes in a single batch. Emphasized nodes keep their emissive material.
  const originalSync = Scene.prototype.sync;
  Scene.prototype.sync = function (...args) {
    originalSync.apply(this, args);
    this.graphRevision = (this.graphRevision || 0) + 1;
    const count = this.recs.size;
    if (!this.nodeBatch || this.nodeBatchCapacity < count) {
      this.nodeBatch?.removeFromParent(); this.nodeBatch?.dispose();
      this.nodeBatchMaterial?.dispose();
      this.nodeBatchCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
      this.nodeBatchMaterial = new THREE.Material({ color: '#ffffff', roughness: .65, metalness: .12 });
      this.mediumGeo ||= new THREE.SphereGeometry(1, 12, 8);
      this.nodeBatch = new THREE.InstancedMesh(count >= 1000 ? this.mediumGeo : this.unitGeo, this.nodeBatchMaterial, this.nodeBatchCapacity);
      this.nodeBatch.frustumCulled = false;
      this.nodeBatch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.nodeGroup.add(this.nodeBatch);
    }
    this.nodeBatch.count = count;
    this.nodeBatch.geometry = count >= 1000 ? this.mediumGeo : this.unitGeo;
    this.updateNodeBatch();
  };
  Scene.prototype.updateNodeBatch = function () {
    if (!this.nodeBatch) return;
    const matrix = this._m, zero = this._vs.set(0, 0, 0);
    let index = 0;
    for (const [id, rec] of this.recs) {
      const emphasized = this.isEmphasized(id);
      rec.mesh.visible = emphasized;
      matrix.compose(rec.mesh.position, rec.mesh.quaternion, emphasized ? zero : rec.mesh.scale);
      this.nodeBatch.setMatrixAt(index, matrix);
      this.batchColor ||= new THREE.Color();
      const color = this.batchColor.copy(rec.mesh.material.color);
      if (this.dimmed && !this.dimmed.has(id)) color.multiplyScalar(.18);
      this.nodeBatch.setColorAt(index++, color);
    }
    this.nodeBatch.instanceMatrix.needsUpdate = true;
    if (this.nodeBatch.instanceColor) this.nodeBatch.instanceColor.needsUpdate = true;
    this.halo.visible = false;
    this.updateLearningPath();
  };
  Scene.prototype.updateLearningPath = function () {
    if (!this.link.mesh) return;
    const key = `${this.graphRevision}|${this.selectedId}|${this.readingPathEnabled !== false}`;
    if (key !== this.learningPathKey) {
      this.learningPathKey = key; this.pathIndices = [];
      if (this.readingPathEnabled !== false && this.selectedId) {
        const pairs = new Map(this.link.pairs.map(([a,b], i) => [a < b ? `${a}|${b}` : `${b}|${a}`, i]));
        const seen = new Set(); let child = this.selectedId;
        for (let i = 0; child && i < 1024; i++) {
          if (seen.has(child)) break; seen.add(child);
          const parent = this.recs.get(child)?.input.parentId;
          if (!parent || !this.recs.has(parent)) break;
          const index = pairs.get(parent < child ? `${parent}|${child}` : `${child}|${parent}`);
          if (index !== undefined) this.pathIndices.push(index);
          child = parent;
        }
      }
      if (!this.pathMesh || this.pathMeshCapacity < this.pathIndices.length) {
        this.pathMesh?.removeFromParent(); this.pathMesh?.dispose(); this.pathMaterial?.dispose();
        this.pathMeshCapacity = Math.max(16, this.pathIndices.length);
        this.pathMaterial = new THREE.BasicMaterial({ color: '#ffffff', opacity: .9, transparent: true, depthWrite: false });
        this.pathMesh = new THREE.InstancedMesh(this.cylGeo, this.pathMaterial, this.pathMeshCapacity);
        this.pathMesh.frustumCulled = false; this.pathMesh.renderOrder = 2;
        this.linkGroup.add(this.pathMesh);
      }
    }
    if (!this.pathMesh) return;
    this.pathMesh.count = this.pathIndices.length;
    this.pathMesh.visible = this.pathIndices.length > 0;
    const color = this.recs.get(this.selectedId)?.mesh.material.color;
    if (color) this.pathMaterial.color.copy(color);
    for (let i = 0; i < this.pathIndices.length; i++) {
      this.link.mesh.getMatrixAt(this.pathIndices[i], this._m);
      const e = this._m.elements;
      for (const index of [0,1,2,8,9,10]) e[index] *= 1.35;
      this.pathMesh.setMatrixAt(i, this._m);
    }
    this.pathMesh.instanceMatrix.needsUpdate = true;
  };
  const styleUniforms = Scene.prototype.applyStyleUniforms;
  Scene.prototype.applyStyleUniforms = function () {
    styleUniforms.call(this);
    if (this.recs.size >= 800) this.linkMat.uniforms.uOpacity.value = Math.max(.06, this.opts.linkOpacity * .65);
  };
  const applyPositions = Scene.prototype.applyPositions;
  Scene.prototype.applyPositions = function (positions) { applyPositions.call(this, positions); this.updateNodeBatch(); };
  const refreshMaterials = Scene.prototype.refreshMaterials;
  Scene.prototype.refreshMaterials = function () { refreshMaterials.call(this); this.updateNodeBatch(); };
  const syncHalo = Scene.prototype.syncHalo;
  Scene.prototype.syncHalo = function () { syncHalo.call(this); this.halo.visible = false; };
  Scene.prototype.updateGlowSprites = function () { this.hideGlowSprites(); };
  const materialFor = Scene.prototype.materialFor;
  Scene.prototype.materialFor = function (color, emphasized, dimmed) {
    const material = materialFor.call(this, color, emphasized, dimmed);
    if (emphasized) material.emissiveIntensity = Math.max(0, this.opts.glowStrength ?? 1) * .9;
    return material;
  };
  const disposeScene = Scene.prototype.dispose;
  Scene.prototype.dispose = function () {
    this.nodeBatch?.removeFromParent(); this.nodeBatch?.dispose();
    this.nodeBatchMaterial?.dispose(); this.nodeBatch = null;
    this.mediumGeo?.dispose(); this.mediumGeo = null;
    this.pathMesh?.removeFromParent(); this.pathMesh?.dispose(); this.pathMaterial?.dispose(); this.pathMesh = null;
    disposeScene.call(this);
  };
  // No full-screen bloom: selected/pinned spheres emit light in their material.
  Renderer.prototype.ensureComposer = function () { return null; };
  const setGraph = Renderer.prototype.setGraph;
  Renderer.prototype.setGraph = function (...args) {
    setGraph.apply(this, args);
    const nodes = args[0], minimumDepth = Math.min(...nodes.map(n => n.depth));
    this.labels.chapterIds = new Set(nodes.filter(n => n.depth === minimumDepth).map(n => n.id));
    this.labels.topicIds = new Set(nodes.filter(n => n.depth === minimumDepth + 1).map(n => n.id));
    this.labels.learningMode = LEARNING_KINDS.has(this.opts.layoutKind) || ['tree','radial'].includes(this.opts.layoutKind);
    const positions = this.layout.transition?.targets || [...this.layoutNodes.values()];
    const farthest = positions.reduce((r, n) => Math.max(r, Math.hypot(n.x,n.y,n.z)), 0);
    this.scene.camera.far = Math.max(40000, farthest * 10);
    this.scene.camera.updateProjectionMatrix();
    const large = this.scene.nodeCount >= 1000;
    this.gl?.setPixelRatio(Math.min(large ? 1.25 : 2, globalThis.devicePixelRatio || 1));
    this.labelBudget = Math.min(this.opts.maxLabels || 600, large ? 180 : 600);
    this.resize();
  };

  // Allocate labels only for the nearest candidates and pinned/selected nodes.
  const labelsSync = Labels.prototype.sync, labelsUpdate = Labels.prototype.update;
  Labels.prototype.sync = function (inputs) {
    this.labelInputs = new Map(inputs.map(x => [x.id, x]));
    const ids = new Set(inputs.map(x => x.id));
    for (const [id, element] of this.items) if (!ids.has(id)) { element.remove(); this.items.delete(id); }
  };
  Labels.prototype.update = function (positions, camera, width, height, options) {
    const budget = Math.min(options.maxLabels || 600, positions.size >= 1000 ? 220 : 600);
    const p = camera.position;
    const candidates = [...positions].map(([id, x]) => ({ id,
      priority: this.pinned.has(id) || id === this.emphasisId ? 0 :
        this.ancestorIds?.has(id) ? .1 : this.chapterIds?.has(id) ? .3 : this.topicIds?.has(id) ? .7 : 1,
      distance: (x.x - p.x) ** 2 + (x.y - p.y) ** 2 + (x.z - p.z) ** 2 }));
    candidates.sort((a, b) => a.priority - b.priority || a.distance - b.distance);
    const selected = candidates.slice(0, budget).map(x => this.labelInputs?.get(x.id)).filter(Boolean);
    labelsSync.call(this, selected);
    const overviewDistance = this.learningMode ? Math.max(options.maxDistance,
      Math.hypot(camera.position.x,camera.position.y,camera.position.z) * 1.75) : options.maxDistance;
    labelsUpdate.call(this, positions, camera, width, height, { ...options, maxLabels: budget, maxDistance: overviewDistance });
    this.el.classList.toggle('om3d-learning-labels', !!this.learningMode);
    if (this.learningMode) for (const id of this.visibleIds) {
      const element = this.items.get(id); if (!element) continue;
      element.style.opacity = this.chapterIds?.has(id) ? '1' : '.9';
      element.classList.toggle('is-chapter', this.chapterIds?.has(id));
    }
  };
  const emphasis = Renderer.prototype.setEmphasis;
  Renderer.prototype.setEmphasis = function (state) {
    emphasis.call(this, state);
    const parents = new Set(); let id = state.selected;
    for (let i = 0; id && i < 1024; i++) {
      id = this.layoutNodes.get(id)?.parentId;
      if (!id || parents.has(id)) break;
      parents.add(id);
    }
    this.labels.ancestorIds = parents;
  };

  class BackgroundModal extends obsidian.Modal {
    constructor(view) { super(view.app); this.view = view; }
    onOpen() {
      const view = this.view, settings = view.host.settings;
      this.setTitle('导图背景');
      const host = this.contentEl; host.classList.add('om3d-background-editor');
      const mode = host.createEl('select', { attr: { 'aria-label': '背景类型' } });
      for (const [value, label] of [['theme', '跟随 Obsidian 主题'], ['solid', '单色背景'], ['gradient', '双色渐变背景']])
        mode.createEl('option', { text: label }).value = value;
      mode.value = settings.bgMode;
      const fields = host.createDiv({ cls: 'om3d-color-fields' });
      const topLabel = fields.createEl('label', { text: '颜色一' });
      const top = topLabel.createEl('input', { type: 'color', value: settings.bgTop });
      const bottomLabel = fields.createEl('label', { text: '颜色二' });
      const bottom = bottomLabel.createEl('input', { type: 'color', value: settings.bgBottom });
      const preview = host.createDiv({ cls: 'om3d-background-preview', text: '背景预览' });
      const update = () => {
        fields.hidden = mode.value === 'theme'; bottomLabel.hidden = mode.value !== 'gradient';
        preview.style.background = mode.value === 'theme' ? 'var(--background-primary)' :
          mode.value === 'solid' ? top.value : `linear-gradient(to bottom, ${top.value}, ${bottom.value})`;
      };
      mode.onchange = top.oninput = bottom.oninput = update; update();
      const actions = host.createDiv({ cls: 'om3d-dialog-actions' });
      actions.createEl('button', { text: '取消' }).onclick = () => this.close();
      actions.createEl('button', { text: '应用背景', cls: 'mod-cta' }).onclick = () => {
        view.applyAppearance({ bgMode: mode.value, bgTop: top.value, bgBottom: bottom.value }); this.close();
      };
    }
    onClose() { this.contentEl.empty(); }
  }

  View.prototype.changeGlow = function (delta) {
    this.applyAppearance({ glowStrength: Math.max(0, Math.min(4, Math.round((this.host.settings.glowStrength + delta) * 100) / 100)) });
  };
  const backgroundItems = View.prototype.backgroundMenuItems;
  function syncRadii(view) {
    if (!view.stage || !view.engine) return;
    for (const [id, rec] of view.stage.scene.recs) {
      const model = view.engine.node(id); if (!model) continue;
      const radius = api.radiusFor(rec.input.depth, { hasNote: rec.input.hasNote, hasFormula: rec.input.hasFormula,
        childCount: rec.input.childCount, scale: view.scaleOfNode(model) });
      rec.input.radius = radius; rec.mesh.scale.setScalar(radius);
      const position = view.stage.scene.positions.get(id); if (position) position.radius = radius;
      const node = view.stage.layoutNodes.get(id); if (node) node.radius = radius;
    }
  }
  const appearance = View.prototype.applyAppearance;
  View.prototype.applyAppearance = function (changes) {
    appearance.call(this, changes);
    if (changes.nodeScale !== undefined && this.stage) {
      syncRadii(this);
      for (const [id, node] of this.stage.layoutNodes) {
        const radius = this.stage.scene.positions.get(id)?.radius;
        if (radius) node.radius = radius;
      }
      clearTimeout(this.radiusReheat);
      this.radiusReheat = setTimeout(() => {
        this.radiusReheat = null;
        if (this.stage?.layout.rust) this.stage.layout.rust.reheat();
        else this.stage?.layout.refreshSpacing();
      }, 120);
    }
  };
  const onClose = View.prototype.onClose;
  View.prototype.onClose = async function (...args) { clearTimeout(this.radiusReheat); this.radiusReheat = null; return onClose.apply(this, args); };
  const applySettings = View.prototype.applySettings;
  View.prototype.applySettings = function (...args) {
    applySettings.apply(this, args);
    if (this.stage) {
      syncRadii(this);
      this.stage.scene.readingPathEnabled = this.host.settings.learningPath !== false;
      this.stage.scene.updateLearningPath();
    }
  };
  View.prototype.recommendReadingCamera = function () {
    const kind = this.stage?.layout.kind;
    const pose = kind === 'bookshelf' ? { azimuth: Math.PI / 2, polar: Math.PI / 2.2 } :
      kind === 'journey' ? { azimuth: Math.PI / 2, polar: Math.PI / 5 } :
      { azimuth: Math.PI / 4, polar: Math.PI / 3 };
    this.stage?.camera.setPose(pose);
    this.stage?.requestFit(); this.schedulePersistPose();
  };
  const applyLayout = View.prototype.applyLayout;
  View.prototype.applyLayout = function (kind) {
    applyLayout.call(this, kind);
    if (LEARNING_KINDS.has(kind)) this.recommendReadingCamera();
  };
  View.prototype.backgroundMenuItems = function () {
    const items = backgroundItems.call(this).filter(x => !x.label?.includes('自定义颜色'));
    return [{ label: '自定义单色 / 双色渐变…', hint: '选择颜色并预览', onPick: () => new BackgroundModal(this).open() },
      { separator: true }, { heading: '背景预设' }, ...items];
  };
  View.prototype.orbitMenuItems = function () {
    const settings = this.host.settings;
    return [{ heading: '旋转方式' },
      ...[['free', '自如旋转', '自由改变旋转中心'], ['selected', '绕选中点旋转', '先选中一个节点'], ['root', '默认旋转', '围绕全图中心旋转']].map(([kind, label, hint]) => ({
        label, hint, checked: settings.orbitCenter === kind,
        disabled: kind === 'selected' && !this.selectedId, onPick: () => this.setOrbitCenter(kind) })),
      { separator: true }, { label: '定位到选中节点', disabled: !this.selectedId, onPick: () => this.locateNode(this.selectedId) },
      { label: '适配全图', onPick: () => this.toolbar.a.fitView() }];
  };

  function menuButton(toolbar, label, items, title) {
    const b = button(label, () => openMenu(b, items(), toolbar.el), title || label);
    b.classList.add('om3d-menubtn'); b.setAttribute('aria-haspopup', 'menu');
    return b;
  }
  function upgradeToolbar(view) {
    const t = view.toolbar, a = t.a;
    if (!t || t.refreshed) return; t.refreshed = true;
    if (view.stage) view.stage.scene.readingPathEnabled = view.host.settings.learningPath !== false;
    const group = (name, children) => {
      const g = document.createElement('div'); g.className = 'om3d-toolgroup';
      const label = document.createElement('span'); label.className = 'om3d-grouplabel'; label.textContent = name;
      g.append(label, ...children); t.el.append(g);
    };
    const action = (label, fn, hint = '') => ({ label, hint, onPick: fn });
    t.el.replaceChildren();
    group('文档', [t.docLabel]);
    group('编辑', [menuButton(t, '节点操作', () => [
      action('新建子级', a.addChild, 'Tab'), action('新建同级', a.addSibling, 'Enter'),
      action('填写备注', a.editNote, '公式、内链与 Markdown'),
      { separator: true }, action('撤销', a.undo, 'Ctrl+Z'), action('重做', a.redo, 'Ctrl+Shift+Z'),
      { separator: true }, { ...action('删除选中子树', a.remove), danger: true }])]);
    group('布局', [t.layoutBtn]);
    group('学习', [menuButton(t, '阅读辅助', () => [
      { heading: '选择学习视图' },
      ...LEARNING_LAYOUTS.map(item => action(item.name, () => view.applyLayout(item.id), item.hint)),
      { separator: true }, { heading: '聚焦概念' },
      { ...action('聚焦选中分支', () => view.setFocus(view.selectedId)), disabled: !view.selectedId },
      action('返回全图', () => view.setFocus(null)),
      action('推荐阅读视角', () => view.recommendReadingCamera()),
      { ...action('查看概念备注', () => view.editNote(view.selectedId), '公式与内链'), disabled: !view.selectedId },
      { separator: true }, { label: '高亮学习路径', checked: view.host.settings.learningPath !== false,
        onPick: () => view.host.updateSettings({ learningPath: view.host.settings.learningPath === false }) }
    ])]);
    group('层级', [menuButton(t, '展开与折叠', () => [
      { heading: '逐层控制' }, action('逐层展开', a.expandStep), action('逐层折叠', a.collapseStep),
      { separator: true }, { heading: '整图控制' }, action('全展开', a.expandAll), action('全折叠', a.collapseAll)])]);
    t.orbitBtn = menuButton(t, '旋转方式', () => view.orbitMenuItems());
    group('视角', [t.orbitBtn, button('适配全图', a.fitView)]);
    t.distMetric = menuButton(t, `间距 ${view.host.settings.linkDistance}`, () => [
      { heading: '节点间距' }, { slider: { label: '长度', min: 20, max: 1200, step: 5,
        value: view.host.settings.linkDistance, onInput: x => view.changeLinkDistance(x - view.host.settings.linkDistance) } },
      ...[40, 80, 160, 320].map(x => action(`间距 ${x}`, () => view.changeLinkDistance(x - view.host.settings.linkDistance))) ]);
    const oldDistance = t.setLinkDistance.bind(t);
    t.setLinkDistance = x => { oldDistance(x); t.distMetric.textContent = `间距 ${x}`; };
    t.glowBtn = menuButton(t, '重点亮度', () => [
      { heading: '球体自发光' }, { slider: { label: '亮度', min: 0, max: 4, step: .05,
        value: view.host.settings.glowStrength, format: x => x.toFixed(2),
        onInput: x => view.applyAppearance({ glowStrength: x }) } },
      action('关闭自发光', () => view.applyAppearance({ glowStrength: 0 })),
      action('恢复默认亮度', () => view.applyAppearance({ glowStrength: 1 }))]);
    group('节点', [t.scaleBtn, t.selScaleBtn, t.distMetric, t.glowBtn]);
    group('连线', [menuButton(t, '连线设置', () => [
      { heading: '线条粗细' }, { slider: { label: '宽度', min: .2, max: 14, step: .2,
        value: view.host.settings.linkWidth, onInput: x => view.applyAppearance({ linkWidth: x }) } },
      action('切换线型', a.cycleLinkStyle), { separator: true }, ...view.linkColorMenuItems(),
      { separator: true }, action('建立关联连线', a.toggleAssoc), ...a.assocMenuItems()])]);
    group('重点', [t.pinBtn, t.pinCaret]);
    group('背景', [t.bgBtn]);
    group('浏览', [t.outlineBtn, button('搜索', a.find), menuButton(t, '更多', () => [
      action('关联其他文档…', a.pickFile), action('导出 PNG', a.exportPNG)])]);
    t.el.append(t.crumb);
    t.el.setAttribute('aria-label', '3D 思维导图工具栏');
    view.measureBarTop();
  }
  const onOpen = View.prototype.onOpen;
  View.prototype.onOpen = async function (...args) { await onOpen.apply(this, args); upgradeToolbar(this); };
  const orbitReadout = api.Toolbar.prototype.setOrbitCenter;
  api.Toolbar.prototype.setOrbitCenter = function (kind, selected) {
    orbitReadout.call(this, kind, selected);
    if (this.refreshed) this.orbitBtn.textContent = { free: '自如旋转', selected: '绕选中点旋转', root: '默认旋转' }[kind] || '旋转方式';
  };
  // Keyboard support is delegated so dynamically built menus share the behavior.
  const onMenuKey = event => {
    const menu = document.querySelector('.om3d-menu');
    if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target?.tagName === 'INPUT') return;
    const items = [...menu.querySelectorAll('button:not(:disabled),input')];
    if (!items.length) return;
    event.preventDefault(); event.stopPropagation();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  };
  const onload = Plugin.prototype.onload;
  Plugin.prototype.onload = async function () {
    this.refreshVersion = VERSION; this.refreshBuildId = api.buildId;
    await onload.call(this);
    this.registerDomEvent(document, 'keydown', onMenuKey, true);
    this.register(() => closeMenu());
  };
}
