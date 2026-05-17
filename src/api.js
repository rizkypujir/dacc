/**
 * api.js — DAC Inception HTTP helpers
 */

const https = require('https');

const BASE    = 'inception.dachain.io';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const REFERER = 'https://inception.dachain.io/';
const ORIGIN  = 'https://inception.dachain.io';

function httpReq(method, path, cookie, csrf, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request(
      {
        hostname: BASE, path, method,
        headers: {
          'accept':       'application/json',
          'content-type': 'application/json',
          'user-agent':   UA,
          'referer':      REFERER,
          'origin':       ORIGIN,
          ...(cookie ? { 'cookie': cookie, 'x-csrftoken': csrf } : {}),
          ...(data   ? { 'content-length': Buffer.byteLength(data) } : {}),
        },
        timeout: 20000,
      },
      (res) => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(b) });
          } catch {
            resolve({ status: res.statusCode, headers: res.headers, body: {} });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Login: GET csrf → POST wallet → return { csrf, sessionid }
 */
async function login(walletAddress) {
  // Step 1: ambil csrftoken
  const r1 = await httpReq('GET', '/api/inception/auth/csrf/', null, null, null);
  const csrfCookie = (r1.headers['set-cookie'] ?? [])
    .find(c => c.startsWith('csrftoken=')) ?? '';
  const csrf = csrfCookie.split(';')[0].replace('csrftoken=', '');
  if (!csrf) throw new Error('Gagal ambil CSRF token');

  // Step 2: login dengan wallet address
  const r2 = await httpReq('POST', '/api/auth/wallet/', 'csrftoken=' + csrf, csrf, {
    wallet_address: walletAddress,
  });
  if (r2.status !== 200) throw new Error(`Login gagal: ${JSON.stringify(r2.body)}`);

  const sidCookie = (r2.headers['set-cookie'] ?? [])
    .find(c => c.startsWith('sessionid=')) ?? '';
  const sessionid = sidCookie.split(';')[0].replace('sessionid=', '');
  if (!sessionid) throw new Error('Gagal ambil session ID');

  return { csrf, sessionid, user: r2.body.user };
}

function makeCookie(csrf, sessionid) {
  return `csrftoken=${csrf}; sessionid=${sessionid}`;
}

// ─── Profile ──────────────────────────────────────────────────────────────────

async function getProfile(csrf, sessionid) {
  const r = await httpReq('GET', '/api/inception/profile/', makeCookie(csrf, sessionid), csrf, null);
  if (r.status !== 200) throw new Error(`Profile gagal: ${r.status}`);
  return r.body;
}

// ─── Faucet ───────────────────────────────────────────────────────────────────

async function claimFaucet(csrf, sessionid) {
  const r = await httpReq('POST', '/api/inception/faucet/', makeCookie(csrf, sessionid), csrf, {});
  return { status: r.status, body: r.body };
}

// ─── Crate ────────────────────────────────────────────────────────────────────

async function openCrate(csrf, sessionid) {
  const r = await httpReq('POST', '/api/inception/crate/open/', makeCookie(csrf, sessionid), csrf, {});
  return { status: r.status, body: r.body };
}

module.exports = { login, getProfile, claimFaucet, openCrate };
