// Builds the standalone index.html from src/. Usage: node build.js
const fs = require('fs');
const core = fs.readFileSync('src/core.js', 'utf8').replace("if (typeof module !== 'undefined') module.exports = OT;\n", '');
const tasks = fs.readFileSync('src/tasks.js', 'utf8').replace("if (typeof module !== 'undefined') module.exports = require('./core.js');\n", '');
const app = fs.readFileSync('src/app.js', 'utf8');
let page = fs.readFileSync('src/page.html', 'utf8').replace('/*CORE*/', () => core).replace('/*TASKS*/', () => tasks).replace('/*APP*/', () => app);
const title = page.match(/<title>[\s\S]*?<\/title>/)[0];
const style = page.match(/<style>[\s\S]*?<\/style>/)[0];
page = page.replace(title, '').replace(style, '').trim();
fs.writeFileSync('index.html', `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${title}
<meta name="description" content="OcuTrace turns a phone video of the eyes into a nystagmus and saccade recording. Research prototype, not for diagnosis.">
<style>html{-webkit-text-size-adjust:100%}:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
${style}
</head>
<body>
${page}
</body>
</html>
`);
console.log('wrote index.html');
