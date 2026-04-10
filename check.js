const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const dStart = html.indexOf('<div id="view-dashboard"');
const dEnd = html.indexOf('<div id="view-screen"');
const dashboardStr = html.substring(dStart, dEnd);
console.log('Dashboard content:\n', dashboardStr.substring(0, 1000));
