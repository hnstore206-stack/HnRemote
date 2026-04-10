const http = require('http');

async function test() {
    // 1. Register a test user
    const resReg = await fetch('http://localhost:3000/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser123', password: 'password', email: 'x@x.com', security_question: '', security_answer: '' })
    });
    console.log('Register:', await resReg.json());
    
    // 2. Login
    const resLog = await fetch('http://localhost:3000/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser123', password: 'password' })
    });
    const logData = await resLog.json();
    console.log('Login:', logData);
    
    const cookie = resLog.headers.get('set-cookie');
    console.log('Cookie:', cookie);
    
    // 3. Add device
    const resDev = await fetch('http://localhost:3000/api/devices', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie
        },
        body: JSON.stringify({ name: 'My Test Device' })
    });
    console.log('Add Device Status:', resDev.status);
    console.log('Add Device Body:', await resDev.text());
}
test().catch(console.error);
