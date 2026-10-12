import fs from 'node:fs';
import path from 'node:path';
const directory = path.resolve(import.meta.dirname, '../_tmp/fixtures');
fs.mkdirSync(directory, { recursive: true });
for (const count of [300, 1200, 3000]) {
  const branches = Array.from({ length: 20 }, (_, i) => `# Branch ${i + 1}\n` +
    Array.from({ length: count / 20 - 1 }, (_, j) => `- Node ${i + 1}.${j + 1}`).join('\n'));
  fs.writeFileSync(path.join(directory, `benchmark_${count}.md`), branches.join('\n') + '\n');
}
fs.writeFileSync(path.join(directory, 'notes_demo.md'), '# Formula and links\n> Energy: $E=mc^2$ and [[link_target#Anchor|Meaningful alias]].\n\n- Child\n> $$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n');
fs.writeFileSync(path.join(directory, 'link_target.md'), '# Anchor\nLocal target for note-link verification.\n');
console.log(`Synthetic fixtures created in ${directory}`);
