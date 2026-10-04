// Runs before `npm run dev/build/preview` and explains common setup problems in
// plain language instead of a cryptic "'vite' is not recognized" error.
// Deliberately dependency-free and written for old Node versions too.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
if (!nodeOk) {
  problems.push(
    `Your Node.js is v${process.versions.node}, but this project needs v20.19+ or v22.12+.\n` +
      '   Install the current LTS from https://nodejs.org, then open a NEW terminal and run `node -v` to check.',
  );
}

if (!existsSync(join(root, 'node_modules', 'vite', 'package.json'))) {
  problems.push(
    'Dependencies are not installed yet (there is no node_modules/vite).\n' +
      '   Run this once in the project folder:\n\n' +
      '       npm install\n\n' +
      '   then run `npm run dev` again.',
  );
}

if (problems.length) {
  console.error('\n✖ Spacegame setup check failed:\n');
  problems.forEach((p, i) => console.error(`${i + 1}. ${p}\n`));
  console.error(`(Project folder: ${root})\n`);
  process.exit(1);
}
