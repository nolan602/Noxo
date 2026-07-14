/**
 * NOXO – Routes Express pour l'API Vinted
 *
 * npm install express express-session node-fetch
 *
 * Dans server.js :
 *   const session      = require('express-session');
 *   const vintedRoutes = require('./vinted-routes');
 *   app.use(session({ secret: 'ton-secret', resave: false, saveUninitialized: false }));
 *   app.use(express.json());
 *   app.use(vintedRoutes);
 */

const express = require('express');
const router  = express.Router();
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─── Headers de base imitant un vrai navigateur ───────────────────────────────
const BASE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':         'https://www.vinted.fr/',
  'Origin':          'https://www.vinted.fr',
  'DNT':             '1',
  'Connection':      'keep-alive',
  'Sec-Fetch-Dest':  'empty',
  'Sec-Fetch-Mode':  'cors',
  'Sec-Fetch-Site':  'same-origin',
};

// ─── ÉTAPE 1 : Récupérer les cookies + token CSRF depuis la page d'accueil ────
async function initVintedSession() {
  const r = await fetch('https://www.vinted.fr/', {
    method: 'GET',
    headers: {
      ...BASE_HEADERS,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
    redirect: 'follow',
  });

  // Extraire tous les cookies
  const rawCookies = (r.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]);
  const cookieStr  = rawCookies.join('; ');

  // Extraire le CSRF token depuis le HTML (meta tag ou JSON inline)
  const html = await r.text();
  let csrfToken = '';

  // Cherche dans <meta name="csrf-token" content="...">
  const metaMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
  if (metaMatch) csrfToken = metaMatch[1];

  // Cherche dans window._config ou data-csrf
  if (!csrfToken) {
    const jsMatch = html.match(/["']csrf_token["']\s*:\s*["']([^"']+)["']/);
    if (jsMatch) csrfToken = jsMatch[1];
  }

  // Fallback : appel endpoint dédié
  if (!csrfToken) {
    try {
      const csrfR = await fetch('https://www.vinted.fr/api/v2/csrf_token', {
        headers: { ...BASE_HEADERS, 'Cookie': cookieStr },
      });
      if (csrfR.ok) {
        const csrfData = await csrfR.json();
        csrfToken = csrfData.csrf_token || '';
      }
    } catch (_) {}
  }

  console.log('[Vinted] Session init — cookies:', rawCookies.length, '— CSRF:', csrfToken ? 'OK' : 'ABSENT');
  return { cookieStr, rawCookies, csrfToken };
}

// ─── HELPER : cookie utilisateur stocké en session Express ───────────────────
function getUserCookie(req) {
  if (req.session?.vinted_session) {
    return `_vinted_fr_session=${req.session.vinted_session}`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vinted/user/:pseudo
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/vinted/user/:pseudo', async (req, res) => {
  const pseudo = req.params.pseudo.trim();
  if (!pseudo) return res.status(400).json({ error: 'Pseudo manquant' });

  try {
    const { cookieStr } = await initVintedSession();
    const url = `https://www.vinted.fr/api/v2/users?search_text=${encodeURIComponent(pseudo)}&per_page=5`;

    const r = await fetch(url, {
      headers: { ...BASE_HEADERS, 'Cookie': cookieStr },
    });

    if (!r.ok) throw new Error('Vinted API ' + r.status);
    const data = await r.json();
    const users = data.users || [];
    const user  = users.find(u => u.login?.toLowerCase() === pseudo.toLowerCase()) || users[0];

    if (!user) return res.status(404).json({ error: 'Pseudo introuvable' });

    return res.json({
      login: user.login,
      photo: user.photo?.url || user.photo?.thumbnails?.[0]?.url || '',
      id:    user.id,
    });
  } catch (e) {
    console.error('[Vinted] /user error:', e.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login-email
// Connexion avec email + mot de passe via formulaire Puppeteer
// Les endpoints REST Vinted (/oauth/token, /api/v2/sessions) retournent 404
// depuis serveur Node — on passe donc par le vrai formulaire web Vinted avec
// le navigateur Puppeteer déjà lancé (cookies DataDome inclus).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/auth/login-email', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  // ── Accéder au navigateur Puppeteer lancé dans server.js ──────────────────
  // server.js expose `global.puppeteerPage` ou `global.page` selon la version.
  const puppeteerPage = global.puppeteerPage || global.page || null;

  if (!puppeteerPage) {
    // Fallback : essayer quand même via node-fetch (peut marcher selon région)
    return loginViaFetch(email, password, req, res);
  }

  try {
    console.log('[Vinted] Login Puppeteer pour :', email);

    // Ouvrir la page de login Vinted dans le navigateur existant
    await puppeteerPage.goto('https://www.vinted.fr/login', {
      waitUntil: 'networkidle2',
      timeout: 20000,
    });

    // Attendre le champ email
    await puppeteerPage.waitForSelector('input[name="email"], input[type="email"], #email', {
      timeout: 10000,
    });

    // Remplir email
    const emailSel = await puppeteerPage.$('input[name="email"]')
      || await puppeteerPage.$('input[type="email"]')
      || await puppeteerPage.$('#email');
    await emailSel.click({ clickCount: 3 });
    await emailSel.type(email, { delay: 40 });

    // Remplir mot de passe
    const passSel = await puppeteerPage.$('input[name="password"]')
      || await puppeteerPage.$('input[type="password"]')
      || await puppeteerPage.$('#password');
    await passSel.click({ clickCount: 3 });
    await passSel.type(password, { delay: 40 });

    // Soumettre le formulaire
    await Promise.all([
      puppeteerPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
      passSel.press('Enter'),
    ]);

    const currentUrl = puppeteerPage.url();
    console.log('[Vinted] URL après login :', currentUrl);

    // ── Détecter une erreur de credentials ───────────────────────────────────
    if (currentUrl.includes('/login')) {
      // Toujours sur /login = identifiants refusés
      const errText = await puppeteerPage.evaluate(() => {
        const el = document.querySelector('[data-testid="login-error"], .error-message, .u-color-red, [class*="error"]');
        return el ? el.innerText.trim() : '';
      });
      console.log('[Vinted] Erreur login détectée :', errText);
      return res.status(401).json({
        error: errText || 'E-mail ou mot de passe incorrect.',
      });
    }

    // ── Login réussi — récupérer le profil via /api/v2/users/me ──────────────
    const me = await puppeteerPage.evaluate(async () => {
      try {
        const r = await fetch('https://www.vinted.fr/api/v2/users/me', {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!r.ok) return null;
        const d = await r.json();
        const u = d.user || d;
        if (!u || !u.login) return null;
        return {
          login: u.login,
          photo: u.photo ? (u.photo.full_size_url || u.photo.url || null) : null,
          id:    u.id || null,
        };
      } catch (_) { return null; }
    });

    if (!me || !me.login) {
      // URL changée mais /me a échoué — essayer de lire le pseudo depuis le DOM
      const loginFromDom = await puppeteerPage.evaluate(() => {
        const el = document.querySelector('[data-testid="header-username"], [class*="username"], [class*="profile-name"]');
        return el ? el.innerText.trim().replace(/^@/, '') : '';
      });
      if (loginFromDom) {
        console.log('[Vinted] Login DOM :', loginFromDom);
        if (req.session) req.session.pendingUser = { login: loginFromDom, photo: '' };
        return res.json({ login: loginFromDom, photo: '' });
      }
      return res.status(503).json({ error: 'Login réussi mais profil inaccessible. Réessaie.' });
    }

    console.log('[Vinted] ✓ Login Puppeteer réussi :', me.login);
    if (req.session) req.session.pendingUser = { login: me.login, photo: me.photo || '' };
    return res.json({ login: me.login, photo: me.photo || '' });

  } catch (e) {
    console.error('[Vinted] Puppeteer login error :', e.message);
    // Dernier recours : fetch classique
    return loginViaFetch(email, password, req, res);
  }
});

// ─── Fallback fetch (si Puppeteer indisponible) ───────────────────────────────
async function loginViaFetch(email, password, req, res) {
  try {
    const { cookieStr, csrfToken } = await initVintedSession();
    const headers = {
      ...BASE_HEADERS,
      'Content-Type':     'application/json',
      'Cookie':           cookieStr,
      'X-Requested-With': 'XMLHttpRequest',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    };

    // Essayer les deux endpoints connus dans l'ordre
    const attempts = [
      {
        url:  'https://www.vinted.fr/api/v2/sessions',
        body: JSON.stringify({ session: { login: email, password }, scope: 'user' }),
      },
      {
        url:  'https://www.vinted.fr/api/v2/users/login',
        body: JSON.stringify({ user: { login: email, password } }),
      },
    ];

    for (const { url, body } of attempts) {
      const r    = await fetch(url, { method: 'POST', headers, body });
      const txt  = await r.text();
      console.log('[Vinted] fetch fallback', url, '->', r.status, txt.substring(0, 120));

      if (r.ok) {
        let d = {};
        try { d = JSON.parse(txt); } catch (_) {}
        const u = d.user || d.member || d.resource_owner || {};
        if (u.login) {
          if (req.session) req.session.pendingUser = { login: u.login, photo: u.photo?.url || '' };
          return res.json({ login: u.login, photo: u.photo?.url || '' });
        }
      }
      if ([400, 401, 422].includes(r.status)) {
        let d = {};
        try { d = JSON.parse(txt); } catch (_) {}
        const msg = d.error_description || d.error || d.message || 'E-mail ou mot de passe incorrect.';
        return res.status(401).json({ error: msg });
      }
      // 404 → endpoint inexistant, on continue
    }

    return res.status(503).json({
      error: 'Impossible de joindre Vinted. Assure-toi d\'être connecté sur vinted.fr dans le navigateur puis réessaie.',
    });
  } catch (e) {
    console.error('[Vinted] fetch fallback error :', e.message);
    return res.status(500).json({ error: 'Erreur serveur : ' + e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/consent
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/auth/consent', async (req, res) => {
  const { accept, login, photo } = req.body || {};
  if (accept && req.session) {
    req.session.noxo_login = login;
    req.session.noxo_photo = photo;
  }
  return res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vinted/notifications
// Vraies notifications — nécessite connexion email
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/vinted/notifications', async (req, res) => {
  const userCookie   = getUserCookie(req);
  const bearerToken  = req.session?.vinted_token;

  if (!userCookie && !bearerToken) {
    return res.status(401).json({ error: 'Non authentifié' });
  }

  try {
    const page    = parseInt(req.query.page     || '1');
    const perPage = parseInt(req.query.per_page || '50');
    const url     = `https://www.vinted.fr/api/v2/notifications?page=${page}&per_page=${perPage}`;

    const headers = { ...BASE_HEADERS };
    if (userCookie)  headers['Cookie']        = userCookie;
    if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

    const r = await fetch(url, { headers });

    if (r.status === 401) {
      if (req.session) { delete req.session.vinted_session; delete req.session.vinted_token; }
      return res.status(401).json({ error: 'Session Vinted expirée, reconnecte-toi' });
    }

    if (!r.ok) throw new Error('Vinted API ' + r.status);

    const data = await r.json();
    const notifications = (data.notifications || data.items || []).map(n => ({
      id:         n.id,
      read:       n.read ?? n.is_read ?? false,
      body:       n.body || n.content || n.message || '',
      created_at: n.created_at || n.date || null,
      user_login: n.sender?.login || n.user?.login || n.from_user?.login || '',
      user_photo: n.sender?.photo?.url || n.user?.photo?.url || n.from_user?.photo?.url || '',
    }));

    return res.json({ notifications, total: data.pagination?.total_count || notifications.length });

  } catch (e) {
    console.error('[Vinted] /notifications error:', e.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});
module.exports = router;