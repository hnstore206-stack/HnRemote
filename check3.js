const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const dStart = html.indexOf('<div id="view-dashboard"');
const dEnd = html.indexOf('<div id="view-screen"');
console.log(html.substring(dStart, dEnd).substring(2000, 3500));
