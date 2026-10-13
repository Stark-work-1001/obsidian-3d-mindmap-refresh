// Benchmark / interaction harness. Usage (served by scripts/dev-server.mjs):
//   /tests/harness/index.html?build=dist&fixture=balanced&count=3000&theme=dark&w=1280&h=760
// build: "dist" (dist/obsidian-3d-mindmap) or "baseline" (_tmp/baseline).
// Everything runs offline against in-memory notes. window.H exposes the API.
import { createApp, obsidianModule, notices } from './obsidian-shim.js';
import * as fixtures from '../fixtures/generate.mjs';

const params = new URLSearchParams(location.search);
const build = params.get('build') ?? 'dist';
const dir = build === 'baseline' ? '_tmp/baseline' : build === 'dist' ? 'dist/obsidian-3d-mindmap' : build;
const theme = params.get('theme') ?? 'dark';
document.body.className = `theme-${theme}`;
const host = document.getElementById('host');
host.style.setProperty('--harness-w', `${Number(params.get('w') ?? 1280)}px`);
host.style.setProperty('--harness-h', `${Number(params.get('h') ?? 760)}px`);

// --- frame instrumentation: time spent inside every rAF callback -----------
const nativeRaf = window.requestAnimationFrame.bind(window);
const work = new Map(); // frame timestamp -> ms of callback work
window.requestAnimationFrame = (cb) => nativeRaf((ts) => {
  const t0 = performance.now();
  try { cb(ts); } finally {
    const d = performance.now() - t0;
    work.set(ts, (work.get(ts) ?? 0) + d);
    if (work.size > 4000) work.delete(work.keys().next().value);
  }
});

function makeFixture() {
  const name = params.get('fixture') ?? 'balanced';
  const count = Number(params.get('count') ?? 300);
  const gen = fixtures[name] ?? fixtures.balanced;
  return gen(count);
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 100) / 100;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const frames = n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : nativeRaf(f)); nativeRaf(f); });

async function boot() {
  const fixture = makeFixture();
  const manifest = await (await fetch(`/${dir}/manifest.json`)).json();
  const css = await (await fetch(`/${dir}/styles.css`)).text();
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  const code = await (await fetch(`/${dir}/main.js`)).text();
  const settings = JSON.parse(params.get('settings') ?? '{}');
  const pluginData = { settings: { layout: params.get('layout') ?? 'force', ...settings } };
  const app = createApp({ files: { 'Fixture.md': fixture.markdown, 'link_target.md': '# Anchor\nTarget.\n' }, pluginData, host });
  const module = { exports: {} };
  const require = (name) => { if (name === 'obsidian') return obsidianModule; throw new Error('unexpected require ' + name); };
  new Function('module', 'exports', 'require', code)(module, module.exports, require);
  const PluginClass = module.exports.default;
  const plugin = new PluginClass(app, { ...manifest, dir });
  await plugin.onload();
  app.workspace.activeFile = app.vault.getAbstractFileByPath('Fixture.md');
  await plugin.activateView('tab');
  const view = () => app.workspace.leaves[0]?.view;
  // 2.0 exposes `internals`; 1.17 (baseline) exposes `stage`.
  const internals = () => view()?.internals ?? null;
  const rootEl = () => view()?.root ?? view()?.contentEl ?? null;
  const isActive = () => { const i = internals(); return i ? !!(i.engine.active || i.renderer?.rig.moving) : !!view()?.stage?.layout?.active; };
  const H = {
    build, dir, manifest, fixture: { name: fixture.name, nodes: fixture.nodes }, app, plugin, view, internals, notices, wait, frames,
    gl() { const i = internals(); if (i) return i.renderer?.renderer ?? null; const s = view()?.stage; return s?.gl ?? s?.renderer?.gl ?? null; },
    isBaseline: build === 'baseline',
    stats() {
      const v = view(); const gl = H.gl(); const i = internals();
      return {
        nodes: i ? i.engine.count : v?.stage?.scene?.nodeCount ?? v?.stage?.scene?.recs?.size ?? null,
        calls: gl?.info.render.calls ?? null,
        triangles: gl?.info.render.triangles ?? null,
        rendered: gl?.info.render.frame ?? null,
        labels: rootEl()?.querySelectorAll('.om3d-label').length ?? null,
        labelsShown: i ? rootEl()?.querySelectorAll('.om3d-label.is-shown').length ?? null : null,
        domElements: rootEl()?.querySelectorAll('*').length ?? null,
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : null,
        layoutActive: isActive(),
        physics: i ? { backend: i.engine.physicsBackend, ...(i.engine.physicsDiagnostics ?? {}) } : null,
      };
    },
    async waitSettled(timeoutMs = 30000) {
      const t0 = performance.now();
      while (performance.now() - t0 < timeoutMs) { if (!isActive()) return performance.now() - t0; await wait(100); }
      return null;
    },
    /** Measure frame cadence and rAF-callback work while `perFrame` drives a scenario. */
    async measure({ seconds = 5, perFrame = null, label = 'measure' } = {}) {
      const gl = H.gl();
      const startRendered = gl?.info.render.frame ?? 0;
      const intervals = [], workMs = [], calls = [], workerMs = [];
      let last = null, maxLabels = 0;
      const heap0 = performance.memory?.usedJSHeapSize ?? null;
      const t0 = performance.now();
      await new Promise(resolve => {
        const loop = (ts) => {
          if (last !== null) { intervals.push(ts - last); workMs.push(work.get(last) ?? 0); }
          last = ts;
          try { perFrame?.(ts); } catch (e) { console.error(e); }
          if (gl) calls.push(gl.info.render.calls);
          const w = H.workerMs(); if (w != null) workerMs.push(w);
          maxLabels = Math.max(maxLabels, rootEl()?.querySelectorAll('.om3d-label').length ?? 0);
          if (performance.now() - t0 < seconds * 1000) nativeRaf(loop); else resolve();
        };
        nativeRaf(loop);
      });
      const elapsed = (performance.now() - t0) / 1000;
      const rendered = (gl?.info.render.frame ?? 0) - startRendered;
      return {
        label, seconds: Math.round(elapsed * 100) / 100,
        displayFps: Math.round(intervals.length / elapsed * 10) / 10,
        renderedPerSecond: Math.round(rendered / elapsed * 10) / 10,
        frameIntervalMs: { p50: percentile(intervals, 50), p95: percentile(intervals, 95), p99: percentile(intervals, 99), max: percentile(intervals, 100) },
        rafWorkMs: { p50: percentile(workMs, 50), p95: percentile(workMs, 95), p99: percentile(workMs, 99), max: percentile(workMs, 100), totalPerSecond: Math.round(workMs.reduce((a, b) => a + b, 0) / elapsed * 10) / 10 },
        drawCalls: { p50: percentile(calls, 50), max: percentile(calls, 100) },
        workerStepMs: workerMs.length ? { p50: percentile(workerMs, 50), p95: percentile(workerMs, 95) } : null,
        labelsDomMax: maxLabels,
        heapDeltaMB: heap0 != null && performance.memory ? Math.round((performance.memory.usedJSHeapSize - heap0) / 1048576 * 10) / 10 : null,
        stats: H.stats(),
      };
    },
    workerMs() {
      const i = internals();
      if (i) { const d = i.engine.physicsDiagnostics; return d && d.stopReason === 'running' ? d.lastStepMs : null; }
      const v = view();
      return v?.stage?.layout?.rust?.ms ?? v?.stage?.layout?.diagnostics?.()?.lastStepMs ?? null;
    },
    orbitStep(dx = 3, dy = 0.4) {
      const i = internals();
      if (i) { i.renderer.rig.orbit(dx, dy); i.renderer.requestFrame(); return; }
      const cam = view()?.stage?.camera;
      if (cam?.orbitBy) cam.orbitBy(dx, dy); else cam?.rotateBy?.(dx, dy);
    },
    setLayout(kind) { if (internals()) plugin.updateSettings({ layout: kind }); else view()?.applyLayout?.(kind); },
    renameRandom(i) {
      const n = internals();
      if (n) {
        const ids = []; const walk = node => { if (node.kind !== 'root') ids.push(node.id); node.children.forEach(walk); }; walk(n.model.root);
        const id = ids[(i * 7919) % ids.length];
        n.sync.perform(m => m.rename(id, `renamed ${i}`));
        return;
      }
      const v = view(); const engine = v?.engine; if (!engine) return;
      const ids = []; const walk = n => { if (n.kind !== 'root') ids.push(n.id); n.children.forEach(walk); }; walk(engine.model.root);
      const id = ids[(i * 7919) % ids.length];
      if (v.renameNode) v.renameNode(id, `renamed ${i}`);
      else { engine.rename(id, `renamed ${i}`); v.rebuild(false); v.onTreeChanged('local'); }
    },
    async scenario(name, seconds = 5) {
      if (name === 'idle') { await H.waitSettled(); await wait(500); return H.measure({ seconds, label: 'settled-idle' }); }
      if (name === 'simulation') { H.setLayout('force'); await frames(2); return H.measure({ seconds, label: 'active-simulation' }); }
      if (name === 'camera') { await H.waitSettled(); return H.measure({ seconds, label: 'camera-orbit', perFrame: () => H.orbitStep() }); }
      if (name === 'editing') {
        await H.waitSettled(); let i = 0, lastEdit = 0;
        // The synchronous cost of each edit (parse, identity matching, rebuild) is timed directly.
        const editMs = [];
        const result = await H.measure({ seconds, label: 'editing', perFrame: ts => {
          if (ts - lastEdit > 400) { lastEdit = ts; const t0 = performance.now(); H.renameRandom(i++); editMs.push(performance.now() - t0); }
        } });
        return { ...result, editMs: { count: editMs.length, p50: percentile(editMs, 50), p95: percentile(editMs, 95), max: percentile(editMs, 100) } };
      }
      if (name === 'transitions') {
        await H.waitSettled(); const kinds = ['knowledge', 'bookshelf', 'journey', 'tree', 'radial']; let i = 0, lastSwitch = 0;
        return H.measure({ seconds, label: 'layout-transitions', perFrame: ts => { if (ts - lastSwitch > 1200) { lastSwitch = ts; H.setLayout(kinds[i++ % kinds.length]); } } });
      }
      if (name === 'emphasized') {
        // Many emphasised nodes: a key-concept rule matching roughly half of all nodes, camera orbiting.
        const rule = { id: 'bench', pattern: 'a', mode: 'contains', depthMax: null, requireNote: false, requireTaskDone: false, enabled: true };
        if (internals()) plugin.updateSettings({ pinRules: [rule] });
        else { const s = plugin.settings ?? plugin.getSettings?.(); plugin.updateSettings?.({ ...(s ?? {}), pinRules: [rule] }); }
        await H.waitSettled(); await wait(300);
        const marked = internals()?.graph?.markIds.size ?? null;
        const result = await H.measure({ seconds, label: 'emphasized-camera', perFrame: () => H.orbitStep() });
        return { ...result, marked };
      }
      if (name === 'animated-bg') {
        if (!internals()) return { label: 'animated-bg', unsupported: true, frameIntervalMs: {}, rafWorkMs: {}, drawCalls: {} };
        plugin.updateSettings({ bgMode: 'gradient', bgTop: '#1d2b44', bgBottom: '#0b0f17', animatedBackground: 'subtle' });
        await H.waitSettled(); await wait(500);
        return H.measure({ seconds, label: 'animated-background-idle' });
      }
      throw new Error('unknown scenario ' + name);
    },
  };
  window.H = H;
  document.getElementById('info').textContent = `${build} ${manifest.version} · ${fixture.name} (${fixture.nodes} nodes) · ${theme}`;
  window.dispatchEvent(new Event('harness-ready'));
}

boot().catch(error => {
  console.error(error);
  document.getElementById('info').textContent = 'harness failed: ' + error.message;
  window.H = { error: String(error?.stack ?? error) };
});
