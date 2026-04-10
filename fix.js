const fs = require('fs');

let html = fs.readFileSync('index.html', 'utf8');

// The file has 14 script tags. The last one is the global script.
// We remove the first 13 script tags to eliminate duplicate/inline scripts.
let scriptCount = 0;
html = html.replace(/<script>[\s\S]*?<\/script>/gi, (match) => {
    scriptCount++;
    // keep the last script
    return scriptCount === 14 ? match : '';
});

// Now we need to remove the immediate execution of load() and fetchScreen() from the bottom of the final script.
// They are written like:
// load();
// if(window.dashInt) clearInterval(dashInt); window.dashInt = setInterval(load, 12000);
// fetchScreen();
// if(window.screenInt) clearInterval(window.screenInt); window.screenInt = setInterval(fetchScreen, 2500);

html = html.replace(/load\(\);\s*setInterval\(load, 12000\);/g, ''); // just in case it wasn't replaced properly.
html = html.replace(/if\(window\.dashInt\) clearInterval\(dashInt\); window\.dashInt = setInterval\(load, 12000\);\s*load\(\);/g, '');
html = html.replace(/load\(\);\s*if\(window\.dashInt\) clearInterval\(dashInt\); window\.dashInt = setInterval\(load, 12000\);/g, '');

// Removing fetchScreen
html = html.replace(/if\(window\.screenInt\) clearInterval\(window\.screenInt\); window\.screenInt = setInterval\(fetchScreen, 2500\).*?fetchScreen\(\);/g, '');


// We need to inject interval starts in the route() function, when it visits the page.
// And stop them when leaving the page.
html = html.replace(/if\(typeof load === 'function'\) load\(\);/g, 
    "if(typeof load === 'function') { load(); if(window.dashInt) clearInterval(window.dashInt); window.dashInt = setInterval(load, 12000); }");

html = html.replace(/if\(typeof fetchScreen === 'function'\) fetchScreen\(\);/g, 
    "if(typeof fetchScreen === 'function') { fetchScreen(); if(window.screenInt) clearInterval(window.screenInt); window.screenInt = setInterval(fetchScreen, 2500); }");


// Also inside route(), clear intervals if we are NOT on the page
html = html.replace(/let path = window\.location\.pathname;/g, 
    `let path = window.location.pathname;
     if (window.dashInt) { clearInterval(window.dashInt); window.dashInt = null; }
     if (window.screenInt) { clearInterval(window.screenInt); window.screenInt = null; }
    `);

// Wait, the dashboardScript also checks isLoggedIn immediately.
html = html.replace(/if \(localStorage\.getItem\("isLoggedIn"\) !== "true"\) navigate\("\/login"\);/g, '');
html = html.replace(/if \(localStorage\.getItem\('isLoggedIn'\) !== 'true'\) window\.location\.href = '\/login';/g, '');

// But we DO want to check auth when load() executes or inside route() if they try to access /dashboard
html = html.replace(/async function load\(\) \{/g, 
    `async function load() {
        if (localStorage.getItem("isLoggedIn") !== "true") { navigate("/login"); return; }
    `);

html = html.replace(/async function logout\(\) \{\s*await fetch\('\/api\/logout', \{ method: 'POST' \}\);\s*localStorage\.clear\(\);\s*window\.location\.href = '\/login';\s*\}/g, '');

// Dashboard script contained a document.getElementById('username').innerText assignment without checking element existence.
html = html.replace(/document\.getElementById\('username'\)\.innerText = localStorage\.getItem\('username'\);/g, 
    `let uEl = document.getElementById('username'); if(uEl) uEl.innerText = localStorage.getItem('username');`);


fs.writeFileSync('index.html', html, 'utf8');
console.log('Fixed index.html!');
