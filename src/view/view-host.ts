// What a map view needs from the plugin. Keeps the view independent of the
// plugin class (and testable with a stand-in).
import type { PhysicsClient } from '../physics/physics-client';
import type { Settings } from '../persistence/settings';
import type { PluginStore } from '../persistence/store';
import type { FormulaCache } from '../render/label-format';

export interface ViewHost {
  readonly version: string;
  readonly store: PluginStore;
  readonly config: Settings;
  readonly formulas: FormulaCache;
  updateSettings(patch: Partial<Settings>): void;
  createPhysics(onFrame: () => void): PhysicsClient;
  /** Save a PNG data URL next to the note; returns the vault path written. */
  exportPng(notePath: string, dataUrl: string): Promise<string | null>;
  openSettings(): void;
  log(message: string, data?: unknown): void;
}
