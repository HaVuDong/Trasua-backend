const fs = require('fs');
const content = fs.readFileSync('node_modules/ioredis-mock/lib/index.js', 'utf8');

const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('xtrim') || line.includes('XTRIM')) {
    console.log(`${idx + 1}: ${line}`);
  }
});
