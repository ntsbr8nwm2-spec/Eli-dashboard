import fs from 'node:fs/promises';

const path = 'parent/index.html';
let src = await fs.readFile(path, 'utf8');
const oldText = '<h2>📅 Canvas Due</h2>';
const newText = '<h2>📅 Canvas Due — Next 7 Days</h2>';
if (!src.includes(oldText)) throw new Error('Canvas Due header target not found.');
src = src.replace(oldText, newText);
await fs.writeFile(path, src, 'utf8');
console.log('Updated Canvas Due header.');
