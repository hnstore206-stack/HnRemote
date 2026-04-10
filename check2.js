const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const dStart = html.indexOf('<div id="view-dashboard"');
const dEnd = html.indexOf('<div id="view-screen"');
const dashboardStr = html.substring(dStart, dEnd);
console.log('Dashboard length is:', dashboardStr.length);
console.log('Contains main-container:', dashboardStr.includes('main-container'));
console.log('Contains nav-custom:', dashboardStr.includes('nav-custom'));
console.log('Contains fab-btn:', dashboardStr.includes('fab-btn'));
