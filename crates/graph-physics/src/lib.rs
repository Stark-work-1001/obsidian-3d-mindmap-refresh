//! WebAssembly bindings for the mind-map layout engine.
mod physics;

use glam::Vec3A;
use physics::{PhysicsEngine, SimulationParams};
use serde_wasm_bindgen::{from_value, to_value};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct GraphPhysicsWasm {
    engine: PhysicsEngine,
}

fn params_from(value: JsValue) -> Result<SimulationParams, JsValue> {
    if value.is_undefined() || value.is_null() {
        return Ok(SimulationParams::default());
    }
    from_value(value).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
impl GraphPhysicsWasm {
    #[wasm_bindgen(constructor)]
    pub fn new(node_count: usize, edges_flat: &[u32], params: JsValue) -> Result<GraphPhysicsWasm, JsValue> {
        Ok(GraphPhysicsWasm { engine: PhysicsEngine::new(node_count, edges_flat, params_from(params)?) })
    }

    pub fn set_edges(&mut self, edges_flat: &[u32], rest: &[f32], strength: &[f32]) {
        self.engine.set_edges(edges_flat, rest, strength);
    }

    pub fn set_params(&mut self, params: JsValue) -> Result<(), JsValue> {
        self.engine.set_params(params_from(params)?);
        Ok(())
    }

    pub fn get_params(&self) -> Result<JsValue, JsValue> {
        to_value(&self.engine.params).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn set_positions(&mut self, positions_flat: &[f32]) { self.engine.set_positions_flat(positions_flat); }

    pub fn set_constraints(&mut self, radii: &[f32], levels: &[f32], fixed: &[f32]) {
        self.engine.set_constraints(radii, levels, fixed);
    }

    pub fn set_radii(&mut self, radii: &[f32]) { self.engine.set_radii(radii); }

    pub fn set_fixed(&mut self, index: u32, x: f32, y: f32, z: f32, fixed: bool) {
        self.engine.set_fixed(index as usize, if fixed { Some(Vec3A::new(x, y, z)) } else { None });
    }

    pub fn reheat(&mut self, energy: f32) { self.engine.reheat(energy); }
    pub fn set_temperature(&mut self, level: f32) { self.engine.set_temperature(level); }

    pub fn step(&mut self) -> bool { self.engine.step() }

    /// Run up to `count` steps; returns whether the simulation is still active.
    pub fn step_n(&mut self, count: u32) -> bool {
        let mut active = false;
        for _ in 0..count {
            active = self.engine.step();
            if !active { break; }
        }
        active && !self.engine.is_converged()
    }

    pub fn energy(&self) -> f32 { self.engine.kinetic_energy }
    pub fn is_converged(&self) -> bool { self.engine.is_converged() }
    pub fn positions_ptr(&self) -> *const f32 { self.engine.positions_ptr() }
    pub fn positions_len(&self) -> usize { self.engine.positions_len() }
    pub fn positions_stride(&self) -> usize { physics::POSITION_STRIDE }
    pub fn edge_count(&self) -> usize { self.engine.edge_count() }

    pub fn temperature(&self) -> f32 { self.engine.temperature() }
    /// 0 = running, 1 = settled, 2 = cooled.
    pub fn stop_reason(&self) -> u32 { self.engine.stop_reason() }

    /// [steps, kinetic_energy, max_displacement, mean_displacement, overlapping_pairs,
    ///  pairs_examined, budget_exhausted, large_nodes, nan_resets, temperature, stop_reason]
    pub fn diagnostics(&self) -> Vec<f32> {
        let d = self.engine.diagnostics;
        vec![
            d.steps as f32, d.kinetic_energy, d.max_displacement, d.mean_displacement, d.overlapping_pairs as f32,
            d.pairs_examined as f32, d.budget_exhausted as f32, d.large_nodes as f32, d.nan_resets as f32,
            d.temperature, d.stop_reason as f32,
        ]
    }
}
