export interface Fixture { name: string; markdown: string; nodes: number | null }
export function balanced(count?: number, seed?: number): Fixture;
export function uneven(count?: number, seed?: number): Fixture;
export function deepChains(count?: number, depth?: number): Fixture;
export function wide(count?: number): Fixture;
export function notesAndLinks(): Fixture;
export function malformed(): Fixture;
export const suites: Record<string, (...args: number[]) => Fixture>;
