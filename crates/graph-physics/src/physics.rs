//! Force-directed layout engine for outline mind maps.
//!
//! Derived from the Obsidian 3D Graph 2.8.1 engine (Aryan Gupta, MIT): the
//! Barnes-Hut octree and integrator structure are kept. Mind-map specific
//! additions: fixed (user-anchored) nodes, per-node collision radii, per-edge
//! rest lengths and stiffness, optional depth shells, input sanitising and
//! explicit convergence diagnostics.
//!
//! The forces are layout heuristics, not a physical simulation; units are
//! scene units per step.

use glam::Vec3A;
use serde::{Deserialize, Serialize};

const EMPTY: u32 = u32::MAX;
/// Below this node count, all-pairs repulsion is cheaper than building an octree.
const OCTREE_THRESHOLD: usize = 64;
/// Octree cells smaller than this stop subdividing (coincident points share a cell).
const MIN_CELL: f32 = 0.001;
pub const MIN_RADIUS: f32 = 0.1;
pub const MAX_RADIUS: f32 = 300.0;
const DEFAULT_RADIUS: f32 = 6.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct SimulationParams {
    pub repulsion: f32,
    /// Base spring stiffness; multiplied by the per-edge strength.
    pub attraction: f32,
    /// Rest length used for edges without an explicit rest length.
    pub link_distance: f32,
    pub gravity: f32,
    pub damping: f32,
    pub max_velocity: f32,
    pub dt: f32,
    pub theta: f32,
    /// Kinetic energy (mean squared velocity) below which the layout is converged.
    pub alpha_min: f32,
    /// Minimum centre distance between two nodes = (r_a + r_b) * collision_scale.
    pub collision_scale: f32,
    /// Fraction of an overlap turned into separating force per step.
    pub collision_strength: f32,
    /// Collision candidate pairs examined per owning node and step.
    pub max_pairs_per_node: u32,
    pub shell_strength: f32,
    /// Shell radius per depth level; 0 means 0.9 x link_distance (1.x behaviour).
    pub shell_spacing: f32,
    /// Fraction of the annealing temperature removed per step (0 disables cooling).
    pub cooling: f32,
    /// The run stops as "cooled" when the temperature falls below this value.
    pub min_temperature: f32,
    /// Consecutive steps below `alpha_min` required to stop as "settled".
    pub calm_steps: u32,
}

impl Default for SimulationParams {
    fn default() -> Self {
        Self {
            repulsion: 400.0,
            attraction: 0.02,
            link_distance: 30.0,
            gravity: 0.05,
            damping: 0.85,
            max_velocity: 40.0,
            dt: 0.3,
            theta: 0.8,
            alpha_min: 0.001,
            collision_scale: 1.15,
            collision_strength: 0.5,
            max_pairs_per_node: 64,
            shell_strength: 0.015,
            shell_spacing: 0.0,
            cooling: 0.0115,
            min_temperature: 0.004,
            calm_steps: 8,
        }
    }
}

impl SimulationParams {
    /// Replace non-finite or out-of-range values with safe ones.
    pub fn sanitized(mut self) -> Self {
        let d = Self::default();
        let fix = |v: f32, lo: f32, hi: f32, fallback: f32| if v.is_finite() { v.clamp(lo, hi) } else { fallback };
        self.repulsion = fix(self.repulsion, 0.0, 1.0e7, d.repulsion);
        self.attraction = fix(self.attraction, 0.0, 10.0, d.attraction);
        self.link_distance = fix(self.link_distance, 0.1, 1.0e5, d.link_distance);
        self.gravity = fix(self.gravity, 0.0, 10.0, d.gravity);
        self.damping = fix(self.damping, 0.0, 0.999, d.damping);
        self.max_velocity = fix(self.max_velocity, 0.01, 1.0e5, d.max_velocity);
        self.dt = fix(self.dt, 1.0e-4, 10.0, d.dt);
        self.theta = fix(self.theta, 0.0, 2.0, d.theta);
        self.alpha_min = fix(self.alpha_min, 0.0, 1.0e6, d.alpha_min);
        self.collision_scale = fix(self.collision_scale, 1.0, 4.0, d.collision_scale);
        self.collision_strength = fix(self.collision_strength, 0.0, 2.0, d.collision_strength);
        self.max_pairs_per_node = self.max_pairs_per_node.clamp(1, 4096);
        self.shell_strength = fix(self.shell_strength, 0.0, 10.0, d.shell_strength);
        self.shell_spacing = fix(self.shell_spacing, 0.0, 1.0e5, 0.0);
        self.cooling = fix(self.cooling, 0.0, 0.5, d.cooling);
        self.min_temperature = fix(self.min_temperature, 1.0e-6, 0.5, d.min_temperature);
        self.calm_steps = self.calm_steps.clamp(1, 1000);
        self
    }
}

// --- Barnes-Hut octree (structure-of-arrays) ----------------------------------

#[derive(Default)]
pub struct OctreeSoA {
    centers_of_mass: Vec<Vec3A>,
    masses: Vec<f32>,
    bounds_sizes: Vec<f32>,
    centers: Vec<Vec3A>,
    bounds_min: Vec<Vec3A>,
    bounds_max: Vec<Vec3A>,
    children: Vec<[u32; 8]>,
    node_indices: Vec<u32>,
    child_counts: Vec<u8>,
    insert_stack: Vec<(u32, u32, Vec3A)>,
    traversal_stack: Vec<u32>,
}

impl OctreeSoA {
    pub fn rebuild(&mut self, positions: &[Vec3A]) {
        self.centers_of_mass.clear();
        self.masses.clear();
        self.bounds_sizes.clear();
        self.centers.clear();
        self.bounds_min.clear();
        self.bounds_max.clear();
        self.children.clear();
        self.node_indices.clear();
        self.child_counts.clear();
        if positions.is_empty() {
            return;
        }
        let mut bmin = positions[0];
        let mut bmax = positions[0];
        for &p in positions.iter().skip(1) {
            bmin = bmin.min(p);
            bmax = bmax.max(p);
        }
        let center = (bmin + bmax) * 0.5;
        let half = ((bmax - bmin) * 0.5).max(Vec3A::splat(1.0)).max_element();
        self.push_cell(center - Vec3A::splat(half), center + Vec3A::splat(half));
        for (index, &position) in positions.iter().enumerate() {
            self.insert(index as u32, position, positions);
        }
    }

    fn push_cell(&mut self, bounds_min: Vec3A, bounds_max: Vec3A) -> u32 {
        let index = self.masses.len() as u32;
        self.centers_of_mass.push(Vec3A::ZERO);
        self.masses.push(0.0);
        self.bounds_sizes.push((bounds_max.x - bounds_min.x).abs());
        self.centers.push((bounds_min + bounds_max) * 0.5);
        self.bounds_min.push(bounds_min);
        self.bounds_max.push(bounds_max);
        self.children.push([EMPTY; 8]);
        self.node_indices.push(EMPTY);
        self.child_counts.push(0);
        index
    }

    fn insert(&mut self, item: u32, position: Vec3A, positions: &[Vec3A]) {
        self.insert_stack.clear();
        self.insert_stack.push((0, item, position));
        while let Some((cell, item, pos)) = self.insert_stack.pop() {
            let c = cell as usize;
            if self.bounds_sizes[c] <= MIN_CELL && self.masses[c] > 0.0 {
                // Coincident points: accumulate mass instead of subdividing forever.
                let mass = self.masses[c] + 1.0;
                self.centers_of_mass[c] = (self.centers_of_mass[c] * self.masses[c] + pos) / mass;
                self.masses[c] = mass;
                continue;
            }
            let mass = self.masses[c] + 1.0;
            self.centers_of_mass[c] = (self.centers_of_mass[c] * self.masses[c] + pos) / mass;
            self.masses[c] = mass;
            let occupant = self.node_indices[c];
            if occupant == EMPTY && self.child_counts[c] == 0 {
                self.node_indices[c] = item;
                continue;
            }
            if occupant != EMPTY {
                self.node_indices[c] = EMPTY;
                let existing = positions[occupant as usize];
                let child = self.child_for(cell, existing);
                self.insert_stack.push((child, occupant, existing));
            }
            let child = self.child_for(cell, pos);
            self.insert_stack.push((child, item, pos));
        }
    }

    fn child_for(&mut self, parent: u32, pos: Vec3A) -> u32 {
        let p = parent as usize;
        let center = self.centers[p];
        let octant = (pos.x >= center.x) as usize | (((pos.y >= center.y) as usize) << 1) | (((pos.z >= center.z) as usize) << 2);
        let existing = self.children[p][octant];
        if existing != EMPTY {
            return existing;
        }
        let (lo, hi) = (self.bounds_min[p], self.bounds_max[p]);
        let cmin = Vec3A::new(
            if octant & 1 != 0 { center.x } else { lo.x },
            if octant & 2 != 0 { center.y } else { lo.y },
            if octant & 4 != 0 { center.z } else { lo.z },
        );
        let cmax = Vec3A::new(
            if octant & 1 != 0 { hi.x } else { center.x },
            if octant & 2 != 0 { hi.y } else { center.y },
            if octant & 4 != 0 { hi.z } else { center.z },
        );
        let index = self.push_cell(cmin, cmax);
        self.children[p][octant] = index;
        self.child_counts[p] += 1;
        index
    }

    pub fn repulsion(&mut self, pos: Vec3A, item: u32, strength: f32, theta: f32) -> Vec3A {
        let mut force = Vec3A::ZERO;
        if self.masses.is_empty() {
            return force;
        }
        self.traversal_stack.clear();
        self.traversal_stack.push(0);
        while let Some(cell) = self.traversal_stack.pop() {
            let c = cell as usize;
            let mass = self.masses[c];
            if mass == 0.0 {
                continue;
            }
            let delta = pos - self.centers_of_mass[c];
            let dist_sq = delta.length_squared().max(1.0);
            let dist = dist_sq.sqrt();
            if self.child_counts[c] == 0 || self.bounds_sizes[c] / dist < theta {
                if self.node_indices[c] != item {
                    force += delta * (strength * mass / (dist_sq * dist));
                }
            } else {
                for &child in &self.children[c] {
                    if child != EMPTY {
                        self.traversal_stack.push(child);
                    }
                }
            }
        }
        force
    }
}

// --- Uniform grid for collision candidates -----------------------------------
//
// Nodes are counting-sorted into hash buckets once per step (no per-query
// allocation). Candidates are filtered by their exact cell, so two cells that
// hash to the same bucket never produce duplicate or foreign pairs. Pairs are
// generated once via the half-neighbourhood: a node's own cell (entries after
// it) plus the 13 "forward" neighbour cells.

const FORWARD: [[i32; 3]; 13] = [
    [1, -1, -1], [1, -1, 0], [1, -1, 1], [1, 0, -1], [1, 0, 0], [1, 0, 1], [1, 1, -1], [1, 1, 0], [1, 1, 1],
    [0, 1, -1], [0, 1, 0], [0, 1, 1], [0, 0, 1],
];

#[derive(Default)]
pub struct CellGrid {
    inv_cell: f32,
    mask: usize,
    bucket_start: Vec<u32>,
    cursor: Vec<u32>,
    sorted: Vec<u32>,
    slot: Vec<u32>,
    keys: Vec<[i32; 3]>,
    buckets: Vec<u32>,
}

#[inline(always)]
fn hash_cell(key: [i32; 3], mask: usize) -> usize {
    let mut h = (key[0] as u32 as u64).wrapping_mul(0x9E37_79B1_85EB_CA87)
        ^ (key[1] as u32 as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F)
        ^ (key[2] as u32 as u64).wrapping_mul(0x1656_67B1_9E37_79F9);
    h ^= h >> 29;
    (h as usize) & mask
}

impl CellGrid {
    pub fn build(&mut self, positions: &[Vec3A], members: &[u32], cell: f32) {
        let n = positions.len();
        self.inv_cell = 1.0 / cell.max(1.0e-3);
        let table = (members.len() * 2).next_power_of_two().max(64);
        self.mask = table - 1;
        self.keys.resize(n, [0; 3]);
        self.slot.resize(n, EMPTY);
        self.buckets.resize(n, 0);
        self.bucket_start.clear();
        self.bucket_start.resize(table + 1, 0);
        for &m in members {
            let i = m as usize;
            let p = positions[i];
            let key = [
                (p.x * self.inv_cell).floor() as i32,
                (p.y * self.inv_cell).floor() as i32,
                (p.z * self.inv_cell).floor() as i32,
            ];
            self.keys[i] = key;
            let b = hash_cell(key, self.mask);
            self.buckets[i] = b as u32;
            self.bucket_start[b + 1] += 1;
        }
        for b in 0..table {
            self.bucket_start[b + 1] += self.bucket_start[b];
        }
        // Stable fill: members stay in ascending index order inside a bucket.
        self.cursor.clear();
        self.cursor.extend_from_slice(&self.bucket_start[..table]);
        self.sorted.clear();
        self.sorted.resize(members.len(), 0);
        for &m in members {
            let i = m as usize;
            let b = self.buckets[i] as usize;
            let at = self.cursor[b] as usize;
            self.sorted[at] = m;
            self.slot[i] = at as u32;
            self.cursor[b] += 1;
        }
    }

    #[inline(always)]
    fn bucket_range(&self, key: [i32; 3]) -> (usize, usize) {
        let b = hash_cell(key, self.mask);
        (self.bucket_start[b] as usize, self.bucket_start[b + 1] as usize)
    }
}

/// Deterministic, roughly uniform direction for separating coincident nodes.
#[inline(always)]
fn pair_direction(i: usize, j: usize) -> Vec3A {
    let mut h = (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (j as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 31;
    h = h.wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^= h >> 29;
    let u = (h & 0xFFFF) as f32 / 65535.0;
    let v = ((h >> 16) & 0xFFFF) as f32 / 65535.0;
    let z = 1.0 - 2.0 * u;
    let r = (1.0 - z * z).max(0.0).sqrt();
    let phi = v * std::f32::consts::TAU;
    Vec3A::new(r * phi.cos(), r * phi.sin(), z)
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct StepDiagnostics {
    pub steps: u32,
    pub kinetic_energy: f32,
    pub max_displacement: f32,
    pub mean_displacement: f32,
    pub overlapping_pairs: u32,
    pub pairs_examined: u32,
    pub budget_exhausted: u32,
    pub large_nodes: u32,
    pub nan_resets: u32,
    pub temperature: f32,
    /// 0 = running, 1 = settled (motion below threshold), 2 = cooled (annealing finished).
    pub stop_reason: u32,
}

pub const STOP_RUNNING: u32 = 0;
pub const STOP_SETTLED: u32 = 1;
pub const STOP_COOLED: u32 = 2;

pub const POSITION_STRIDE: usize = 4;

pub struct PhysicsEngine {
    pub positions: Vec<Vec3A>,
    pub velocities: Vec<Vec3A>,
    forces: Vec<Vec3A>,
    edges: Vec<[u32; 2]>,
    edge_rest: Vec<f32>,
    edge_strength: Vec<f32>,
    pub params: SimulationParams,
    pub kinetic_energy: f32,
    octree: OctreeSoA,
    fine: CellGrid,
    coarse: CellGrid,
    small_members: Vec<u32>,
    all_members: Vec<u32>,
    large: Vec<u32>,
    radius_scratch: Vec<f32>,
    fixed: Vec<Option<Vec3A>>,
    radii: Vec<f32>,
    levels: Vec<f32>,
    pub diagnostics: StepDiagnostics,
    step_count: u32,
    temperature: f32,
    calm: u32,
    stop_reason: u32,
    collision_gain: f32,
}

impl PhysicsEngine {
    pub fn new(node_count: usize, edges_flat: &[u32], params: SimulationParams) -> Self {
        let golden = (1.0 + 5.0_f32.sqrt()) / 2.0;
        let scale = 50.0 * (node_count as f32).sqrt().max(1.0);
        let positions = (0..node_count)
            .map(|i| {
                let theta = std::f32::consts::TAU * i as f32 / golden;
                let phi = if node_count <= 1 { 0.0 } else { (1.0 - 2.0 * (i as f32 + 0.5) / node_count as f32).clamp(-1.0, 1.0).acos() };
                let r = scale * ((i as f32 + 1.0) / node_count.max(1) as f32).sqrt();
                Vec3A::new(r * phi.sin() * theta.cos(), r * phi.sin() * theta.sin(), r * phi.cos())
            })
            .collect();
        let mut engine = Self {
            positions,
            velocities: vec![Vec3A::ZERO; node_count],
            forces: vec![Vec3A::ZERO; node_count],
            edges: Vec::new(),
            edge_rest: Vec::new(),
            edge_strength: Vec::new(),
            params: params.sanitized(),
            kinetic_energy: 1.0,
            octree: OctreeSoA::default(),
            fine: CellGrid::default(),
            coarse: CellGrid::default(),
            small_members: Vec::with_capacity(node_count),
            all_members: (0..node_count as u32).collect(),
            large: Vec::new(),
            radius_scratch: Vec::with_capacity(node_count),
            fixed: vec![None; node_count],
            radii: vec![DEFAULT_RADIUS; node_count],
            levels: vec![0.0; node_count],
            diagnostics: StepDiagnostics::default(),
            step_count: 0,
            temperature: 1.0,
            calm: 0,
            stop_reason: STOP_RUNNING,
            collision_gain: 1.0,
        };
        engine.set_edges(edges_flat, &[], &[]);
        engine
    }

    pub fn node_count(&self) -> usize { self.positions.len() }
    pub fn edge_count(&self) -> usize { self.edges.len() }

    /// Edges as flat index pairs with optional per-edge rest length and strength.
    /// Out-of-range indices, self-loops and duplicates are dropped.
    pub fn set_edges(&mut self, edges_flat: &[u32], rest: &[f32], strength: &[f32]) {
        let n = self.positions.len() as u32;
        let mut entries: Vec<([u32; 2], f32, f32)> = Vec::with_capacity(edges_flat.len() / 2);
        for e in 0..edges_flat.len() / 2 {
            let (a, b) = (edges_flat[e * 2], edges_flat[e * 2 + 1]);
            if a >= n || b >= n || a == b {
                continue;
            }
            let r = rest.get(e).copied().filter(|v| v.is_finite() && *v > 0.0).unwrap_or(f32::NAN);
            let s = strength.get(e).copied().filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(1.0);
            entries.push(([a.min(b), a.max(b)], r, s));
        }
        entries.sort_by(|x, y| x.0.cmp(&y.0));
        entries.dedup_by(|x, y| x.0 == y.0);
        self.edges = entries.iter().map(|e| e.0).collect();
        self.edge_rest = entries.iter().map(|e| e.1).collect();
        self.edge_strength = entries.iter().map(|e| e.2.min(100.0)).collect();
        self.restart(1.0);
    }

    /// Resume the simulation with at least `level` annealing temperature (0..1).
    pub fn restart(&mut self, level: f32) {
        let level = if level.is_finite() { level.clamp(0.0, 1.0) } else { 1.0 };
        self.temperature = if self.stop_reason == STOP_RUNNING { self.temperature.max(level) } else { level.max(self.params.min_temperature * 2.0) };
        self.stop_reason = STOP_RUNNING;
        self.calm = 0;
    }

    pub fn temperature(&self) -> f32 { self.temperature }

    /// Set the annealing temperature directly (e.g. a gentle start after a small edit).
    pub fn set_temperature(&mut self, level: f32) {
        self.temperature = if level.is_finite() { level.clamp(self.params.min_temperature * 2.0, 1.0) } else { 1.0 };
        self.stop_reason = STOP_RUNNING;
        self.calm = 0;
    }
    pub fn stop_reason(&self) -> u32 { self.stop_reason }

    pub fn set_params(&mut self, params: SimulationParams) {
        self.params = params.sanitized();
        self.restart(0.8);
    }

    pub fn set_positions_flat(&mut self, flat: &[f32]) {
        let n = self.positions.len();
        let stride = if flat.len() >= n * 4 { 4 } else { 3 };
        for i in 0..n.min(flat.len() / stride) {
            let p = Vec3A::new(flat[i * stride], flat[i * stride + 1], flat[i * stride + 2]);
            if p.is_finite() {
                self.positions[i] = p;
            }
            self.velocities[i] = Vec3A::ZERO;
        }
        self.restart(1.0);
    }

    pub fn set_constraints(&mut self, radii: &[f32], levels: &[f32], fixed: &[f32]) {
        for i in 0..self.positions.len() {
            self.radii[i] = radii.get(i).copied().filter(|r| r.is_finite()).unwrap_or(DEFAULT_RADIUS).clamp(MIN_RADIUS, MAX_RADIUS);
            self.levels[i] = levels.get(i).copied().filter(|l| l.is_finite()).unwrap_or(0.0).max(0.0);
            self.fixed[i] = if fixed.len() >= (i + 1) * 4 && fixed[i * 4 + 3] > 0.5 {
                let p = Vec3A::new(fixed[i * 4], fixed[i * 4 + 1], fixed[i * 4 + 2]);
                if p.is_finite() { Some(p) } else { None }
            } else {
                None
            };
        }
        self.restart(1.0);
    }

    pub fn set_radii(&mut self, radii: &[f32]) {
        for i in 0..self.positions.len() {
            self.radii[i] = radii.get(i).copied().filter(|r| r.is_finite()).unwrap_or(DEFAULT_RADIUS).clamp(MIN_RADIUS, MAX_RADIUS);
        }
        self.restart(0.4);
    }

    /// Pin or release one node (dragging). Pinned nodes ignore forces.
    pub fn set_fixed(&mut self, index: usize, position: Option<Vec3A>) {
        if index >= self.positions.len() {
            return;
        }
        match position.filter(|p| p.is_finite()) {
            Some(p) => {
                self.fixed[index] = Some(p);
                self.positions[index] = p;
                self.velocities[index] = Vec3A::ZERO;
            }
            None => self.fixed[index] = None,
        }
        self.restart(0.3);
    }

    pub fn reheat(&mut self, energy: f32) {
        self.restart(energy);
    }

    pub fn positions_ptr(&self) -> *const f32 { self.positions.as_ptr() as *const f32 }
    pub fn positions_len(&self) -> usize { self.positions.len() * POSITION_STRIDE }
    /// The run has stopped (settled or cooled) until the next restart.
    pub fn is_converged(&self) -> bool { self.stop_reason != STOP_RUNNING }

    pub fn step(&mut self) -> bool {
        let n = self.positions.len();
        if n == 0 || self.is_converged() {
            return false;
        }
        self.step_count = self.step_count.wrapping_add(1);
        let mut diag = StepDiagnostics { steps: self.diagnostics.steps.wrapping_add(1), ..StepDiagnostics::default() };
        for f in self.forces.iter_mut() {
            *f = Vec3A::ZERO;
        }
        let p = self.params;
        let t = self.temperature.max(1.0e-6);
        // Collisions keep at least 25% strength while the layout cools, so
        // overlaps are still being resolved when the run stops.
        self.collision_gain = t.max(0.25) / t;

        // Repulsion.
        if n > OCTREE_THRESHOLD {
            self.octree.rebuild(&self.positions);
            for i in 0..n {
                let force = self.octree.repulsion(self.positions[i], i as u32, p.repulsion, p.theta);
                self.forces[i] += force;
            }
        } else {
            for i in 0..n {
                let pi = self.positions[i];
                let mut fi = Vec3A::ZERO;
                for j in (i + 1)..n {
                    let delta = pi - self.positions[j];
                    let dist_sq = delta.length_squared().max(1.0);
                    let f = delta * (p.repulsion / (dist_sq * dist_sq.sqrt()));
                    fi += f;
                    self.forces[j] -= f;
                }
                self.forces[i] += fi;
            }
        }

        // Springs with per-edge rest length and stiffness.
        for (e, &[a, b]) in self.edges.iter().enumerate() {
            let (a, b) = (a as usize, b as usize);
            let delta = self.positions[b] - self.positions[a];
            let dist = delta.length();
            if dist < 1.0e-4 {
                continue;
            }
            let rest = if self.edge_rest[e].is_nan() { p.link_distance } else { self.edge_rest[e] };
            let force = delta * (p.attraction * self.edge_strength[e] * (dist - rest) / dist);
            self.forces[a] += force;
            self.forces[b] -= force;
        }

        // Centring and optional depth shells.
        let spacing = if p.shell_spacing > 0.0 { p.shell_spacing } else { p.link_distance * 0.9 };
        for i in 0..n {
            let pos = self.positions[i];
            self.forces[i] -= pos * p.gravity;
            if self.levels[i] > 0.0 && p.shell_strength > 0.0 {
                let distance = pos.length().max(0.01);
                self.forces[i] += pos * ((self.levels[i] * spacing - distance) / distance) * p.shell_strength;
            }
        }

        self.collide(&mut diag);

        // Integrate (semi-implicit Euler with damping and a speed limit).
        let max_v_sq = p.max_velocity * p.max_velocity;
        let mut total_v_sq = 0.0_f32;
        let mut total_disp = 0.0_f32;
        let mut movable = 0u32;
        for i in 0..n {
            if let Some(anchor) = self.fixed[i] {
                self.positions[i] = anchor;
                self.velocities[i] = Vec3A::ZERO;
                continue;
            }
            let mut v = (self.velocities[i] + self.forces[i] * (p.dt * t)) * p.damping;
            let v_sq = v.length_squared();
            if v_sq > max_v_sq {
                v *= p.max_velocity / v_sq.sqrt();
            }
            let displacement = v * p.dt;
            let next = self.positions[i] + displacement;
            if !next.is_finite() || !v.is_finite() {
                self.velocities[i] = Vec3A::ZERO;
                diag.nan_resets += 1;
                continue;
            }
            self.velocities[i] = v;
            self.positions[i] = next;
            let d = displacement.length();
            diag.max_displacement = diag.max_displacement.max(d);
            total_disp += d;
            total_v_sq += v.length_squared();
            movable += 1;
        }
        self.kinetic_energy = if movable > 0 { total_v_sq / movable as f32 } else { 0.0 };
        diag.kinetic_energy = self.kinetic_energy;
        diag.mean_displacement = if movable > 0 { total_disp / movable as f32 } else { 0.0 };
        self.temperature *= 1.0 - p.cooling;
        self.calm = if self.kinetic_energy < p.alpha_min { self.calm + 1 } else { 0 };
        if self.calm >= p.calm_steps {
            self.stop_reason = STOP_SETTLED;
        } else if p.cooling > 0.0 && self.temperature < p.min_temperature {
            self.stop_reason = STOP_COOLED;
        }
        diag.temperature = self.temperature;
        diag.stop_reason = self.stop_reason;
        self.diagnostics = diag;
        true
    }

    #[inline(always)]
    fn apply_pair(&mut self, i: usize, j: usize, diag: &mut StepDiagnostics) {
        let p = self.params;
        let delta = self.positions[i] - self.positions[j];
        let minimum = (self.radii[i] + self.radii[j]) * p.collision_scale;
        let dist_sq = delta.length_squared();
        if dist_sq >= minimum * minimum {
            return;
        }
        diag.overlapping_pairs += 1;
        let dist = dist_sq.sqrt();
        let direction = if dist > 1.0e-4 { delta / dist } else { pair_direction(i, j) };
        let push = direction * ((minimum - dist) * p.collision_strength * self.collision_gain);
        match (self.fixed[i].is_some(), self.fixed[j].is_some()) {
            (true, true) => {}
            (true, false) => self.forces[j] -= push * 2.0,
            (false, true) => self.forces[i] += push * 2.0,
            (false, false) => {
                self.forces[i] += push;
                self.forces[j] -= push;
            }
        }
    }

    /// Radius-aware separation with a strict per-node work bound: at most
    /// `max_pairs_per_node` candidate pairs and 8x that many grid entries are
    /// visited per owning node and step. Remaining overlaps in very dense
    /// clusters are resolved over subsequent steps (the neighbour order
    /// rotates every step so the same candidates are not always skipped).
    fn collide(&mut self, diag: &mut StepDiagnostics) {
        let n = self.positions.len();
        let p = self.params;
        // Reference radius: 1.5 x the 90th percentile. Larger nodes use a coarse grid.
        self.radius_scratch.clear();
        self.radius_scratch.extend_from_slice(&self.radii);
        let k = ((n as f32 * 0.9) as usize).min(n - 1);
        let (_, r90, _) = self.radius_scratch.select_nth_unstable_by(k, |a, b| a.total_cmp(b));
        let r_ref = (*r90 * 1.5).max(MIN_RADIUS);
        let r_max = self.radii.iter().copied().fold(MIN_RADIUS, f32::max);
        self.small_members.clear();
        self.large.clear();
        for i in 0..n {
            if self.radii[i] > r_ref { self.large.push(i as u32); } else { self.small_members.push(i as u32); }
        }
        diag.large_nodes = self.large.len() as u32;
        let budget = p.max_pairs_per_node as usize;
        let visit_cap = budget * 8;
        let rotate = (self.step_count as usize) % FORWARD.len();

        // Small-small pairs on the fine grid.
        let members = std::mem::take(&mut self.small_members);
        let mut fine = std::mem::take(&mut self.fine);
        fine.build(&self.positions, &members, 2.0 * r_ref * p.collision_scale);
        for &m in &members {
            let i = m as usize;
            let key = fine.keys[i];
            let (mut pairs, mut visited) = (0usize, 0usize);
            // Own cell: only entries after `i`, so each pair is visited once.
            let (_, end) = fine.bucket_range(key);
            let mut slot = fine.slot[i] as usize + 1;
            while slot < end && pairs < budget && visited < visit_cap {
                let j = fine.sorted[slot] as usize;
                slot += 1;
                visited += 1;
                if fine.keys[j] != key { continue; }
                pairs += 1;
                self.apply_pair(i, j, diag);
            }
            for f in 0..FORWARD.len() {
                if pairs >= budget || visited >= visit_cap { break; }
                let o = FORWARD[(f + rotate) % FORWARD.len()];
                let cell = [key[0] + o[0], key[1] + o[1], key[2] + o[2]];
                let (start, end) = fine.bucket_range(cell);
                for s in start..end {
                    if pairs >= budget || visited >= visit_cap { break; }
                    let j = fine.sorted[s] as usize;
                    visited += 1;
                    if fine.keys[j] != cell { continue; }
                    pairs += 1;
                    self.apply_pair(i, j, diag);
                }
            }
            diag.pairs_examined += pairs as u32;
            if pairs >= budget || visited >= visit_cap { diag.budget_exhausted += 1; }
        }
        self.fine = fine;
        self.small_members = members;

        // Pairs involving at least one large node, on a coarse grid sized for r_max.
        if !self.large.is_empty() {
            let all = std::mem::take(&mut self.all_members);
            let mut coarse = std::mem::take(&mut self.coarse);
            coarse.build(&self.positions, &all, 2.0 * r_max * p.collision_scale);
            let large = std::mem::take(&mut self.large);
            let large_budget = budget * 4;
            let large_cap = visit_cap * 4;
            for &l in &large {
                let i = l as usize;
                let key = coarse.keys[i];
                let (mut pairs, mut visited) = (0usize, 0usize);
                'cells: for dx in -1..=1 {
                    for dy in -1..=1 {
                        for dz in -1..=1 {
                            let cell = [key[0] + dx, key[1] + dy, key[2] + dz];
                            let (start, end) = coarse.bucket_range(cell);
                            for s in start..end {
                                if pairs >= large_budget || visited >= large_cap { break 'cells; }
                                let j = coarse.sorted[s] as usize;
                                visited += 1;
                                if j == i || coarse.keys[j] != cell { continue; }
                                // Large-large pairs once; large-small always from the large side.
                                if self.radii[j] > r_ref && j < i { continue; }
                                pairs += 1;
                                self.apply_pair(i, j, diag);
                            }
                        }
                    }
                }
                diag.pairs_examined += pairs as u32;
                if pairs >= large_budget || visited >= large_cap { diag.budget_exhausted += 1; }
            }
            self.large = large;
            self.coarse = coarse;
            self.all_members = all;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> SimulationParams {
        SimulationParams {
            repulsion: 14000.0, attraction: 0.12, link_distance: 80.0, gravity: 0.002, damping: 0.78,
            max_velocity: 45.0, dt: 0.4, theta: 0.85, alpha_min: 0.002, ..SimulationParams::default()
        }
    }

    fn worst_overlap(e: &PhysicsEngine) -> f32 {
        let mut worst = 0.0_f32;
        for i in 0..e.positions.len() {
            for j in (i + 1)..e.positions.len() {
                let need = (e.radii[i] + e.radii[j]) * e.params.collision_scale;
                worst = worst.max(need - (e.positions[i] - e.positions[j]).length());
            }
        }
        worst
    }

    #[test]
    fn coincident_nodes_separate_without_nan() {
        let mut e = PhysicsEngine::new(3000, &[], params());
        e.set_positions_flat(&vec![0.0; 12000]);
        for _ in 0..40 { e.step(); }
        assert!(e.positions.iter().all(|p| p.is_finite()));
        let spread = e.positions.iter().map(|p| p.length()).fold(0.0_f32, f32::max);
        assert!(spread > 10.0, "spread {spread}");
        assert_eq!(e.diagnostics.nan_resets, 0);
    }

    #[test]
    fn collision_work_is_bounded_per_node() {
        let mut e = PhysicsEngine::new(2000, &[], SimulationParams { max_pairs_per_node: 16, ..params() });
        e.set_positions_flat(&vec![0.0; 8000]);
        e.step();
        assert!(e.diagnostics.pairs_examined as usize <= 2000 * 16, "examined {}", e.diagnostics.pairs_examined);
        assert!(e.diagnostics.budget_exhausted > 0);
    }

    #[test]
    fn each_overlapping_pair_is_counted_once() {
        // 27 nodes in a tight 3x3x3 block overlap pairwise: C(27, 2) = 351 pairs.
        let mut e = PhysicsEngine::new(27, &[], SimulationParams { repulsion: 0.0, gravity: 0.0, max_pairs_per_node: 4096, ..params() });
        let mut flat = vec![0.0; 27 * 4];
        for i in 0..27 { flat[i * 4] = (i % 3) as f32; flat[i * 4 + 1] = ((i / 3) % 3) as f32; flat[i * 4 + 2] = (i / 9) as f32; }
        e.set_positions_flat(&flat);
        e.step();
        assert_eq!(e.diagnostics.overlapping_pairs, 351);
        assert_eq!(e.diagnostics.pairs_examined, 351);
    }

    #[test]
    fn neighbours_at_the_collision_threshold_are_found() {
        // 1.x queried r_i + r_max although the threshold is 1.15 (r_i + r_j);
        // two equal nodes 2.2 r apart were never tested and stayed overlapping.
        let mut e = PhysicsEngine::new(2, &[], SimulationParams { repulsion: 0.0, gravity: 0.0, ..params() });
        e.set_positions_flat(&[0.0, 0.0, 0.0, 0.0, 13.2, 0.0, 0.0, 0.0]);
        e.step();
        assert_eq!(e.diagnostics.overlapping_pairs, 1);
    }

    #[test]
    fn large_nodes_collide_with_small_neighbours() {
        let n = 200;
        let mut e = PhysicsEngine::new(n, &[], SimulationParams { repulsion: 0.0, gravity: 0.0, ..params() });
        let mut radii = vec![4.0; n];
        radii[0] = 60.0;
        let mut flat = vec![0.0; n * 4];
        for i in 1..n {
            let a = i as f32 * 2.399;
            flat[i * 4] = 30.0 * a.cos() + (i as f32) * 0.3;
            flat[i * 4 + 1] = 30.0 * a.sin();
            flat[i * 4 + 2] = (i % 7) as f32 * 3.0;
        }
        e.set_positions_flat(&flat);
        e.set_constraints(&radii, &vec![0.0; n], &[]);
        for _ in 0..600 { e.step(); }
        assert!(e.diagnostics.large_nodes == 1);
        let need = (60.0 + 4.0) * e.params.collision_scale;
        let closest = (1..n).map(|i| (e.positions[i] - e.positions[0]).length()).fold(f32::MAX, f32::min);
        assert!(closest > need * 0.9, "closest {closest} need {need}");
    }

    #[test]
    fn fixed_nodes_stay_fixed_and_invalid_input_is_sanitised() {
        let mut e = PhysicsEngine::new(3, &[0, 1, 1, 7, 2, 2, 1, 0], params());
        assert_eq!(e.edge_count(), 1, "dangling, self and duplicate edges are dropped");
        e.set_positions_flat(&[10.0, 20.0, 30.0, 0.0, f32::NAN, 0.0, 0.0, 0.0, 5.0, 5.0, 5.0, 0.0]);
        e.set_constraints(&[8.0, f32::INFINITY, -1.0], &[0.0, 1.0, f32::NAN], &[10.0, 20.0, 30.0, 1.0, f32::NAN, 0.0, 0.0, 1.0]);
        for _ in 0..50 { e.step(); }
        assert_eq!(e.positions[0], Vec3A::new(10.0, 20.0, 30.0));
        assert!(e.positions.iter().all(|p| p.is_finite()));
    }

    #[test]
    fn per_edge_rest_length_sets_spacing() {
        let mut e = PhysicsEngine::new(2, &[0, 1], SimulationParams { repulsion: 0.0, gravity: 0.0, shell_strength: 0.0, cooling: 0.0, ..params() });
        e.set_edges(&[0, 1], &[150.0], &[1.0]);
        e.set_positions_flat(&[-10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0]);
        for _ in 0..2000 { if !e.step() { break; } }
        let d = (e.positions[1] - e.positions[0]).length();
        assert!((d - 150.0).abs() < 3.0, "distance {d}");
    }

    #[test]
    fn tree_converges_without_overlap() {
        let n = 300;
        let edges: Vec<u32> = (1..n as u32).flat_map(|i| [(i - 1) / 4, i]).collect();
        let mut e = PhysicsEngine::new(n, &edges, params());
        let mut steps = 0;
        while e.step() && steps < 5000 { steps += 1; }
        assert!(e.is_converged(), "not stopped after {steps} steps, energy {}", e.kinetic_energy);
        assert!(steps < 700, "annealing should end the run in bounded steps ({steps})");
        assert!(e.diagnostics.max_displacement < 0.05, "residual motion {}", e.diagnostics.max_displacement);
        assert!(worst_overlap(&e) < 1.0, "overlap {}", worst_overlap(&e));
    }

    #[test]
    fn a_spring_overshoot_is_not_mistaken_for_convergence() {
        let mut e = PhysicsEngine::new(2, &[0, 1], SimulationParams { repulsion: 0.0, gravity: 0.0, shell_strength: 0.0, cooling: 0.0, damping: 0.95, ..params() });
        e.set_edges(&[0, 1], &[150.0], &[1.0]);
        e.set_positions_flat(&[-10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0]);
        let mut steps = 0;
        while e.step() && steps < 20000 { steps += 1; }
        assert_eq!(e.stop_reason(), STOP_SETTLED);
        let d = (e.positions[1] - e.positions[0]).length();
        assert!((d - 150.0).abs() < 2.0, "stopped at {d}");
    }

    #[test]
    fn restart_resumes_a_stopped_run() {
        let mut e = PhysicsEngine::new(10, &[], params());
        while e.step() {}
        assert!(e.is_converged());
        e.set_fixed(3, Some(Vec3A::new(500.0, 0.0, 0.0)));
        assert!(!e.is_converged());
        assert!(e.step());
    }

    #[test]
    fn hostile_parameters_are_clamped() {
        let p = SimulationParams { dt: f32::NAN, damping: 7.0, max_pairs_per_node: 0, collision_scale: -3.0, ..params() }.sanitized();
        assert!(p.dt > 0.0 && p.damping < 1.0 && p.max_pairs_per_node >= 1 && p.collision_scale >= 1.0);
    }
}

