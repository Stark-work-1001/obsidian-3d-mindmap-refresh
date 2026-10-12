import { workerCode, wasmBase64 } from './generated-physics.js';

export function parameters(options) {
  return { repulsion: Math.abs(options.chargeStrength || -260) * 55,
    attraction: 0.12, link_distance: options.linkDistance || 62,
    gravity: 0.002, damping: 0.78, max_velocity: 45, dt: 0.4,
    theta: 0.85, alpha_min: 0.002 };
}

export function buffers(nodes) {
  const positions = new Float32Array(nodes.length * 4);
  const fixed = new Float32Array(nodes.length * 4);
  const radii = new Float32Array(nodes.length), levels = new Float32Array(nodes.length);
  nodes.forEach((n, i) => {
    positions.set([n.x || 0, n.y || 0, n.z || 0, 0], i * 4);
    radii[i] = n.radius || 6;
    levels[i] = n.depth || 0;
    const anchor = n.anchor || (Number.isFinite(n.fx) ? { x: n.fx, y: n.fy, z: n.fz } : null);
    if (anchor) fixed.set([anchor.x, anchor.y, anchor.z, 1], i * 4);
  });
  return { positions, fixed, radii, levels };
}

// One outstanding request: no work queue, no detached buffers retained by the UI.
export class RustLayout {
  constructor(owner, nodes, links, fail) {
    this.owner = owner; this.nodes = nodes; this.fail = fail;
    this.active = true; this.ready = false; this.inFlight = false;
    this.latest = null; this.ms = 0; this.ticks = 0; this.disposed = false; this.epoch = 0;
    const url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
    this.worker = new Worker(url);
    URL.revokeObjectURL(url);
    const map = new Map(nodes.map((n, i) => [n.id, i]));
    const edges = [];
    for (const l of links) if (map.has(l.source) && map.has(l.target)) edges.push(map.get(l.source), map.get(l.target));
    const bytes = Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0));
    this.worker.onmessage = ({ data: m }) => {
      if (this.disposed) return;
      if (m.type === 'READY') { this.ready = true; clearTimeout(this.timer); }
      if (m.type === 'ERROR') this.error(m.error);
      if (m.type === 'TICK') {
        this.inFlight = false;
        if (m.epoch !== this.epoch) {
          this.worker.postMessage({ type: 'RETURN', buffer: m.buffer }, [m.buffer]);
          return;
        }
        if (this.latest) this.worker.postMessage({ type: 'RETURN', buffer: this.latest.buffer }, [this.latest.buffer]);
        this.latest = { buffer: m.buffer, active: m.active };
        this.ms = m.ms; this.ticks = m.ticks;
      }
    };
    this.worker.onerror = e => this.error(e.message);
    this.timer = setTimeout(() => this.error('Rust worker initialization timed out'), 12000);
    this.worker.postMessage({ type: 'INIT', bytes, count: nodes.length,
      edges: new Uint32Array(edges), params: parameters(owner.opts), ...buffers(nodes) });
  }
  error(message) {
    if (this.disposed) return;
    console.error('[3D Mind Map Rust]', message);
    this.dispose(); this.fail(message);
  }
  step() {
    if (this.latest) {
      const m = this.latest, positions = new Float32Array(m.buffer);
      this.nodes.forEach((n, i) => {
        if (n.anchor || Number.isFinite(n.fx)) return;
        n.x = positions[i * 4]; n.y = positions[i * 4 + 1]; n.z = positions[i * 4 + 2];
      });
      this.active = m.active;
      this.latest = null;
      this.worker.postMessage({ type: 'RETURN', buffer: m.buffer }, [m.buffer]);
    }
    if (this.ready && this.active && !this.inFlight) {
      this.inFlight = true; this.worker.postMessage({ type: 'STEP' });
    }
    return this.active ? 0.1 : 0;
  }
  reheat() {
    if (this.disposed) return;
    this.active = true;
    if (this.latest) {
      this.worker.postMessage({ type: 'RETURN', buffer: this.latest.buffer }, [this.latest.buffer]);
      this.latest = null;
    }
    this.worker.postMessage({ type: 'REHEAT', epoch: ++this.epoch, params: parameters(this.owner.opts), ...buffers(this.nodes) });
  }
  dispose() {
    this.disposed = true; this.active = false; clearTimeout(this.timer);
    this.worker?.terminate(); this.latest = null;
  }
}
