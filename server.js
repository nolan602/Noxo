// =============================================================================
// Serveur backend de la landing page NOXO
// -----------------------------------------------------------------------------
// Rôle : recevoir les inscriptions du formulaire (modale d'authentification de
// index.html), créer le compte et l'enregistrer automatiquement dans un fichier
// séparé et dédié : backend/data/comptes.json
//
// - Le mot de passe n'est JAMAIS stocké en clair : il est haché avec bcrypt.
// - Chaque compte reçoit un identifiant unique (UUID), un email et une date de
//   création (horodatage ISO).
// - La liste des comptes peut être consultée à tout moment :
//     1) directement dans le fichier backend/data/comptes.json
//     2) via la page d'administration  http://localhost:3001/comptes.html
//        (ou en double-cliquant sur backend/comptes.html — aucune clé requise)
//     3) via l'API                     GET /api/comptes
//
// Démarrage :
//   cd backend
//   npm install
//   npm start
//
// Par défaut, ce serveur sert aussi index.html (et le reste du site) en statique
// depuis le dossier parent, pour que tout fonctionne sur la même origine (pas de
// souci de CORS). Si ta page est déjà servie ailleurs, tu peux changer
// API_BASE_URL dans index.html pour pointer vers l'URL de ce serveur.
// =============================================================================

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const https = require('https');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3001;

// Permet à req.ip de refléter l'IP réelle du client (via x-forwarded-for)
// quand le serveur tourne derrière un proxy/reverse-proxy (Render, Nginx...).
app.set('trust proxy', true);

// --- Fichier dédié au stockage des comptes (distinct du reste du projet) ---
const DATA_DIR = path.join(__dirname, 'data');
const COMPTES_FILE = path.join(DATA_DIR, 'comptes.json');

function ensureComptesFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(COMPTES_FILE)) fs.writeFileSync(COMPTES_FILE, '[]\n', 'utf8');
}
ensureComptesFile();

function lireComptes() {
  ensureComptesFile();
  try {
    const contenu = fs.readFileSync(COMPTES_FILE, 'utf8');
    return JSON.parse(contenu || '[]');
  } catch (err) {
    console.error('Erreur de lecture de comptes.json :', err);
    return [];
  }
}

function ecrireComptes(comptes) {
  fs.writeFileSync(COMPTES_FILE, JSON.stringify(comptes, null, 2) + '\n', 'utf8');
}

// --- Fichier dédié au stockage des codes promo (panneau admin comptes.html) ---
const PROMOS_FILE = path.join(DATA_DIR, 'promos.json');

function ensurePromosFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROMOS_FILE)) fs.writeFileSync(PROMOS_FILE, '[]\n', 'utf8');
}
ensurePromosFile();

function lirePromos() {
  ensurePromosFile();
  try {
    const contenu = fs.readFileSync(PROMOS_FILE, 'utf8');
    return JSON.parse(contenu || '[]');
  } catch (err) {
    console.error('Erreur de lecture de promos.json :', err);
    return [];
  }
}

function ecrirePromos(promos) {
  fs.writeFileSync(PROMOS_FILE, JSON.stringify(promos, null, 2) + '\n', 'utf8');
}

// --- Fichier dédié à l'historique des notifications globales (panneau admin comptes.html) ---
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');

function ensureNotificationsFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(NOTIFICATIONS_FILE)) fs.writeFileSync(NOTIFICATIONS_FILE, '[]\n', 'utf8');
}
ensureNotificationsFile();

function lireNotifications() {
  ensureNotificationsFile();
  try {
    const contenu = fs.readFileSync(NOTIFICATIONS_FILE, 'utf8');
    return JSON.parse(contenu || '[]');
  } catch (err) {
    console.error('Erreur de lecture de notifications.json :', err);
    return [];
  }
}

function ecrireNotifications(notifications) {
  fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2) + '\n', 'utf8');
}

// --- Fichier dédié aux bandeaux d'annonces du site (panneau admin comptes.html) ---
// 3 types indépendants : maintenance / promo / alerte, chacun avec son propre message + statut actif.
const BANNERS_FILE = path.join(DATA_DIR, 'banners.json');
const BANNERS_PAR_DEFAUT = {
  maintenance: { type: 'maintenance', active: false, message: '', startTime: '', endTime: '', updatedAt: null },
  promo: { type: 'promo', active: false, message: '', updatedAt: null },
  alerte: { type: 'alerte', active: false, message: '', updatedAt: null }
};

function ensureBannersFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BANNERS_FILE)) fs.writeFileSync(BANNERS_FILE, JSON.stringify(BANNERS_PAR_DEFAUT, null, 2) + '\n', 'utf8');
}
ensureBannersFile();

function lireBanners() {
  ensureBannersFile();
  try {
    const contenu = fs.readFileSync(BANNERS_FILE, 'utf8');
    const data = JSON.parse(contenu || '{}');
    // Merge avec les valeurs par défaut pour être sûr d'avoir toujours les 3 types
    return {
      maintenance: { ...BANNERS_PAR_DEFAUT.maintenance, ...(data.maintenance || {}) },
      promo: { ...BANNERS_PAR_DEFAUT.promo, ...(data.promo || {}) },
      alerte: { ...BANNERS_PAR_DEFAUT.alerte, ...(data.alerte || {}) }
    };
  } catch (err) {
    console.error('Erreur de lecture de banners.json :', err);
    return { ...BANNERS_PAR_DEFAUT };
  }
}

function ecrireBanners(banners) {
  fs.writeFileSync(BANNERS_FILE, JSON.stringify(banners, null, 2) + '\n', 'utf8');
}

// --- Fichier dédié au vrai mode maintenance (panneau admin comptes.html) ---
// Contrairement au bandeau "maintenance" (simple message affiché en haut du
// site), ce mode bloque réellement l'accès au site pour les visiteurs : une
// fois actif, toute page/asset du site public renvoie une page de maintenance
// (voir middleware plus bas). Seuls comptes.html et les routes /api/* restent
// joignables, pour que l'admin puisse continuer à travailler et désactiver
// le mode depuis le panneau.
const MAINTENANCE_FILE = path.join(DATA_DIR, 'maintenance.json');
const MAINTENANCE_PAR_DEFAUT = {
  active: false,
  message: 'Le site est actuellement en maintenance. Merci de repasser un peu plus tard.',
  updatedAt: null
};

function ensureMaintenanceFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MAINTENANCE_FILE)) fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify(MAINTENANCE_PAR_DEFAUT, null, 2) + '\n', 'utf8');
}
ensureMaintenanceFile();

function lireMaintenance() {
  ensureMaintenanceFile();
  try {
    const contenu = fs.readFileSync(MAINTENANCE_FILE, 'utf8');
    const data = JSON.parse(contenu || '{}');
    return { ...MAINTENANCE_PAR_DEFAUT, ...data };
  } catch (err) {
    console.error('Erreur de lecture de maintenance.json :', err);
    return { ...MAINTENANCE_PAR_DEFAUT };
  }
}

function ecrireMaintenance(maintenance) {
  fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify(maintenance, null, 2) + '\n', 'utf8');
}

// Page HTML renvoyée aux visiteurs tant que le mode maintenance est actif.
// Reprend l'esthétique sombre/glassmorphism du reste du site (accent cyan).
function pageMaintenanceHtml(message) {
  const messageSecurise = String(message || MAINTENANCE_PAR_DEFAUT.message)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Maintenance en cours — NOXO</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(circle at 50% 20%, #0f1b2d 0%, #060a12 70%);
    font-family: 'Segoe UI', Arial, sans-serif; color: #d7e2f5; padding: 20px;
  }
  .card {
    max-width: 460px; text-align: center; padding: 40px 36px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(56,189,248,0.25);
    border-radius: 18px; backdrop-filter: blur(14px); box-shadow: 0 0 40px rgba(56,189,248,0.1);
  }
  .icon { font-size: 42px; margin-bottom: 18px; }
  h1 { font-size: 22px; margin: 0 0 14px; color: #fff; }
  p { font-size: 14.5px; line-height: 1.6; color: #9fb0c9; margin: 0; }
  .accent { color: #38bdf8; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">🛠️</div>
    <h1>Site en <span class="accent">maintenance</span></h1>
    <p>${messageSecurise}</p>
  </div>
</body>
</html>`;
}

// --- Fichier dédié aux logs d'activité (panneau admin comptes.html) ---
// Historique global de toutes les actions importantes effectuées sur la
// plateforme (comptes, promos, notifications, site, abonnements...).
// Plafonné à 300 entrées : les plus anciennes sont supprimées automatiquement
// dès que la limite est dépassée.
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const ACTIVITY_LIMITE = 300;

function ensureActivityFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ACTIVITY_FILE)) fs.writeFileSync(ACTIVITY_FILE, '[]\n', 'utf8');
}
ensureActivityFile();

function lireActivite() {
  ensureActivityFile();
  try {
    const contenu = fs.readFileSync(ACTIVITY_FILE, 'utf8');
    return JSON.parse(contenu || '[]');
  } catch (err) {
    console.error('Erreur de lecture de activity.json :', err);
    return [];
  }
}

function ecrireActivite(logs) {
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(logs, null, 2) + '\n', 'utf8');
}

// Ajoute une entrée en tête de l'historique (plus récent en premier) et
// tronque à ACTIVITY_LIMITE entrées. category ∈ comptes/promos/notifications/
// site/abonnements. level ∈ info/succes/warning/danger (couleur du point
// dans le panneau admin).
function ajouterLog(category, level, message) {
  const logs = lireActivite();
  logs.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    category,
    level,
    message,
    date: new Date().toISOString()
  });
  ecrireActivite(logs.slice(0, ACTIVITY_LIMITE));
}

// --- Fichier dédié aux 3 abonnements Noxo (panneau admin comptes.html) ---
// 3 plans fixes : starter / pro / expert, chacun avec son prix, son nombre
// d'utilisateurs connectés autorisés, et la liste des fonctionnalités activées.
const ABONNEMENTS_FILE = path.join(DATA_DIR, 'abonnements.json');
const ABONNEMENTS_FEATURES_PAR_DEFAUT = {
  achat1clic: false, stats: false, fluxTempsReel: false, filtresIllimites: false,
  conversation: false, messageAuto: false, alerteInstant: false, multicop: false,
  sniper: false, supportPrioritaire: false, ia: false
};
const ABONNEMENTS_PAR_DEFAUT = {
  starter: {
    plan: 'starter', price: 19.99, users: 1,
    features: { ...ABONNEMENTS_FEATURES_PAR_DEFAUT, achat1clic: true, stats: true, fluxTempsReel: true, filtresIllimites: true },
    updatedAt: null
  },
  pro: {
    plan: 'pro', price: 69.99, users: 3,
    features: { ...ABONNEMENTS_FEATURES_PAR_DEFAUT, achat1clic: true, stats: true, fluxTempsReel: true, filtresIllimites: true, conversation: true, messageAuto: true, alerteInstant: true, multicop: true },
    updatedAt: null
  },
  expert: {
    plan: 'expert', price: 149.99, users: 5,
    features: { achat1clic: true, stats: true, fluxTempsReel: true, filtresIllimites: true, conversation: true, messageAuto: true, alerteInstant: true, multicop: true, sniper: true, supportPrioritaire: true, ia: true },
    updatedAt: null
  }
};

function ensureAbonnementsFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ABONNEMENTS_FILE)) fs.writeFileSync(ABONNEMENTS_FILE, JSON.stringify(ABONNEMENTS_PAR_DEFAUT, null, 2) + '\n', 'utf8');
}
ensureAbonnementsFile();

function lireAbonnements() {
  ensureAbonnementsFile();
  try {
    const contenu = fs.readFileSync(ABONNEMENTS_FILE, 'utf8');
    const data = JSON.parse(contenu || '{}');
    // Merge avec les valeurs par défaut pour être sûr d'avoir toujours les 3 plans + toutes les features
    const merge = (plan) => ({
      ...ABONNEMENTS_PAR_DEFAUT[plan],
      ...(data[plan] || {}),
      features: { ...ABONNEMENTS_FEATURES_PAR_DEFAUT, ...((data[plan] || {}).features || {}) }
    });
    return { starter: merge('starter'), pro: merge('pro'), expert: merge('expert') };
  } catch (err) {
    console.error('Erreur de lecture de abonnements.json :', err);
    return { ...ABONNEMENTS_PAR_DEFAUT };
  }
}

function ecrireAbonnements(abonnements) {
  fs.writeFileSync(ABONNEMENTS_FILE, JSON.stringify(abonnements, null, 2) + '\n', 'utf8');
}

// -----------------------------------------------------------------------------
// Purge automatique des comptes "unverified" créés il y a plus de 30 minutes.
// Un compte reste "unverified" tant que le code de vérification par email n'a
// pas été confirmé (cf. PATCH /api/comptes/:id/statut). Passé ce délai, on
// considère l'inscription abandonnée et on supprime le compte.
// -----------------------------------------------------------------------------
const DELAI_EXPIRATION_NON_VERIFIE_MS = 30 * 60 * 1000; // 30 minutes

function purgerComptesNonVerifies() {
  const comptes = lireComptes();
  const maintenant = Date.now();

  const comptesRestants = comptes.filter((c) => {
    if (c.status !== 'unverified') return true;
    const cree = new Date(c.createdAt).getTime();
    if (Number.isNaN(cree)) return true; // pas de date exploitable -> on ne touche pas
    const expire = (maintenant - cree) > DELAI_EXPIRATION_NON_VERIFIE_MS;
    if (expire) {
      console.log(`[NOXO] Compte non vérifié expiré, supprimé : ${c.email} (${c.id})`);
      ajouterLog('comptes', 'warning', `Compte non vérifié expiré, supprimé automatiquement : ${c.email}`);
    }
    return !expire;
  });

  if (comptesRestants.length !== comptes.length) {
    ecrireComptes(comptesRestants);
  }
}

// Vérifie toutes les 5 minutes, + un premier passage juste après le démarrage.
setInterval(purgerComptesNonVerifies, 5 * 60 * 1000);
setTimeout(purgerComptesNonVerifies, 5000);

// -----------------------------------------------------------------------------
// ID court et DÉFINITIF (7 caractères max) affiché dans le panneau admin.
// Généré une seule fois à la création du compte, jamais régénéré ensuite.
// Distinct de "id" (UUID complet) qui reste utilisé en interne pour toutes
// les routes API (suppression, rôle, mot de passe...) — le shortId n'est là
// que pour l'affichage.
// -----------------------------------------------------------------------------
function genererIdCourt(comptesExistants) {
  const caracteres = '0123456789abcdefghijklmnopqrstuvwxyz';
  let id;
  do {
    id = '';
    for (let i = 0; i < 7; i++) {
      id += caracteres[Math.floor(Math.random() * caracteres.length)];
    }
  } while (comptesExistants.some((c) => c.shortId === id));
  return id;
}

// -----------------------------------------------------------------------------
// Chiffrement réversible (AES-256-GCM) des mots de passe en clair.
// -----------------------------------------------------------------------------
// bcrypt (passwordHash) reste utilisé pour la VÉRIFICATION de connexion : c'est
// un hash à sens unique, le plus sûr pour cet usage, et il n'est jamais modifié.
// En parallèle, on chiffre le mot de passe en clair avec AES-256-GCM (réversible)
// et on stocke le résultat dans "passwordEnc", uniquement pour permettre de
// l'afficher dans le panneau d'administration (comptes.html) à la demande.
// La clé de chiffrement est générée une fois et stockée dans data/enc.key —
// si ce fichier est perdu, les mots de passe déjà chiffrés ne sont plus
// déchiffrables (mais les comptes restent utilisables pour la connexion).
// -----------------------------------------------------------------------------
const ENC_KEY_FILE = path.join(DATA_DIR, 'enc.key');
function getEncryptionKey() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ENC_KEY_FILE)) {
    fs.writeFileSync(ENC_KEY_FILE, crypto.randomBytes(32).toString('hex'), 'utf8');
  }
  return Buffer.from(fs.readFileSync(ENC_KEY_FILE, 'utf8').trim(), 'hex');
}
const ENC_KEY = getEncryptionKey();

function chiffrerMotDePasse(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const chiffre = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + chiffre.toString('hex');
}

function dechiffrerMotDePasse(enc) {
  if (!enc || typeof enc !== 'string' || enc.indexOf(':') === -1) return null;
  try {
    const [ivHex, tagHex, dataHex] = enc.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dechiffre = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return dechiffre.toString('utf8');
  } catch (err) {
    console.error('Erreur de déchiffrement du mot de passe :', err);
    return null;
  }
}

function emailEstValide(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// -----------------------------------------------------------------------------
// Récupère l'adresse IP réelle du client. Si le serveur tourne derrière un
// proxy/reverse-proxy (Render, Vercel, Nginx...), l'IP réelle se trouve dans
// l'en-tête x-forwarded-for (on prend la première, la plus à gauche, qui est
// celle du client d'origine). Sinon on retombe sur req.ip / req.socket.
//
// En local (serveur lancé sur le même PC que le navigateur), req.ip vaut
// toujours 127.0.0.1 / ::1 (et idem en réseau local : 192.168.x.x...), ce
// qui n'est pas l'IP "publique" attendue dans le panneau admin. Dans ce cas
// on va chercher la vraie IP publique de la machine via un service externe.
// -----------------------------------------------------------------------------
function estIpLocale(ip) {
  if (!ip) return true;
  return ip === '127.0.0.1' || ip === '::1'
    || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.')
    || ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.')
    || ip.startsWith('172.2') || ip.startsWith('172.30.') || ip.startsWith('172.31.');
}

function obtenirIpPublique() {
  const services = ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://checkip.amazonaws.com'];
  const essayer = (i) => new Promise((resolve) => {
    if (i >= services.length) return resolve('');
    https.get(services[i], { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const ip = nettoyerIp(data.trim());
        if (ip && !estIpLocale(ip)) {
          resolve(ip);
        } else {
          console.warn(`[NOXO] Service IP ${services[i]} n'a pas renvoyé d'IP publique valide, on tente le suivant.`);
          essayer(i + 1).then(resolve);
        }
      });
    }).on('error', (err) => {
      console.warn(`[NOXO] Erreur récupération IP publique via ${services[i]} :`, err.message);
      essayer(i + 1).then(resolve);
    }).on('timeout', function () {
      this.destroy();
      console.warn(`[NOXO] Timeout récupération IP publique via ${services[i]}.`);
      essayer(i + 1).then(resolve);
    });
  });
  return essayer(0);
}

async function getIp(req) {
  let ip = '';
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const premiere = String(xff).split(',')[0].trim();
    if (premiere) ip = nettoyerIp(premiere);
  }
  if (!ip) ip = nettoyerIp(req.ip || (req.socket && req.socket.remoteAddress) || '');

  if (estIpLocale(ip)) {
    const ipPublique = await obtenirIpPublique();
    if (ipPublique) return ipPublique;
    console.warn('[NOXO] Impossible de récupérer une IP publique réelle (tous les services ont échoué) — IP locale utilisée en secours :', ip, '. Vérifie la connexion internet du serveur / un pare-feu ou antivirus qui bloquerait les requêtes HTTPS sortantes.');
  }
  return ip;
}

// Normalise les adresses IPv4 mappées en IPv6 (::ffff:127.0.0.1 -> 127.0.0.1)
// et les adresses de boucle locale IPv6 (::1 -> 127.0.0.1) pour un affichage lisible.
function nettoyerIp(ip) {
  if (!ip) return '';
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

app.use(express.json());

// CORS : autorise les appels venant de n'importe quelle origine (utile quand
// index.html / comptes.html sont ouverts directement en double-cliquant sur
// le fichier, sans passer par ce serveur — l'origine est alors "file://").
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// -----------------------------------------------------------------------------
// MODE MAINTENANCE — bloque l'accès au site pour les visiteurs.
// Doit s'exécuter AVANT express.static pour intercepter toutes les pages/assets
// du site public. Restent toujours joignables, même en maintenance :
//   - /comptes.html (panneau admin)
//   - toutes les routes /api/* (nécessaires pour que le panneau admin
//     continue de fonctionner et puisse désactiver le mode)
// Il n'y a pas de système de connexion admin séparé sur ce projet (usage
// local) : la distinction "visiteur / admin" se fait donc uniquement sur ces
// deux exceptions, pas sur une session utilisateur.
// -----------------------------------------------------------------------------
app.use((req, res, next) => {
  const maintenance = lireMaintenance();
  if (!maintenance.active) return next();

  const chemin = req.path || '';
  if (chemin === '/comptes.html' || chemin.startsWith('/api/')) {
    return next();
  }

  res.status(503).set('Content-Type', 'text/html; charset=utf-8').send(pageMaintenanceHtml(maintenance.message));
});

// Sert le site statique (index.html et assets) depuis le même dossier que server.js.
app.use(express.static(__dirname));

// Page d'administration pour consulter la liste des comptes (voir comptes.html).
app.get('/comptes.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'comptes.html'));
});

// -----------------------------------------------------------------------------
// POST /api/inscription
// Crée un nouveau compte : email + mot de passe (haché) + date + ID unique.
// Appelée automatiquement par index.html une fois le code de vérification
// email validé (inscription classique par mot de passe).
// -----------------------------------------------------------------------------
app.post('/api/inscription', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');

    if (!emailEstValide(email)) {
      return res.status(400).json({ success: false, message: 'Adresse email invalide.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Le mot de passe doit contenir au moins 6 caractères.' });
    }

    const comptes = lireComptes();
    const compteExistant = comptes.find((c) => c.email === email);
    if (compteExistant) {
      const nomProvider = compteExistant.provider === 'google' ? 'Google'
        : compteExistant.provider === 'discord' ? 'Discord'
        : null;
      return res.status(409).json({
        success: false,
        code: 'EMAIL_EXISTS',
        provider: compteExistant.provider || 'password',
        message: nomProvider
          ? `Un compte existe déjà avec cette adresse email via ${nomProvider}. Veuillez vous connecter avec ${nomProvider}.`
          : 'Un compte existe déjà avec cette adresse email. Veuillez vous connecter.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const passwordEnc = chiffrerMotDePasse(password);
    const maintenant = new Date().toISOString();

    const nouveauCompte = {
      id: crypto.randomUUID(),
      shortId: genererIdCourt(comptes),
      email: email,
      name: email,
      provider: 'password',
      picture: '',
      passwordHash: passwordHash,
      passwordEnc: passwordEnc,
      // Le compte est créé dès l'envoi du code EmailJS, AVANT que
      // l'utilisateur ne l'ait saisi : il démarre donc "unverified".
      // Le passage à "verified" se fait via PATCH /api/comptes/:id/statut,
      // appelé par index.html une fois le bon code confirmé.
      status: 'unverified',
      // Aucun système de paiement n'est encore branché : tout nouveau compte
      // démarre "user". Le passage à "premium" se fait manuellement via
      // PATCH /api/comptes/:id/role (bouton "Changer le rôle" du panneau admin),
      // en attendant un vrai webhook de paiement.
      role: 'user',
      createdAt: maintenant,
      lastLoginAt: maintenant,
      // sessionCount ne compte QUE les sessions ayant réellement généré du
      // temps trackable (voir /ping) : on ne l'incrémente plus à la création
      // du compte, sinon chaque inscription (même sans usage réel derrière)
      // diluait la moyenne de durée de session vers 0.
      sessionCount: 0,
      lastIp: await getIp(req)
    };

    comptes.push(nouveauCompte);
    ecrireComptes(comptes);

    console.log(`[NOXO] Nouveau compte créé (password) : ${email} (${nouveauCompte.id})`);
    ajouterLog('comptes', 'succes', `Nouveau compte créé : ${email}`);
    return res.status(201).json({
      success: true,
      id: nouveauCompte.id,
      email: nouveauCompte.email,
      name: nouveauCompte.name,
      picture: nouveauCompte.picture,
      provider: nouveauCompte.provider,
      createdAt: nouveauCompte.createdAt
    });
  } catch (err) {
    console.error("Erreur lors de la création du compte :", err);
    return res.status(500).json({ success: false, message: 'Erreur serveur. Veuillez réessayer.' });
  }
});

// -----------------------------------------------------------------------------
// POST /api/connexion
// Vérifie un email + mot de passe par rapport à comptes.json, sur le serveur
// (et donc identique quel que soit l'ordinateur qui appelle cette route).
// C'est ce qui permet à un compte créé sur un PC d'être utilisable sur un autre.
// -----------------------------------------------------------------------------
app.post('/api/connexion', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');

    if (!emailEstValide(email)) {
      return res.status(400).json({ success: false, code: 'INVALID_EMAIL', message: 'Adresse email invalide.' });
    }
    if (!password) {
      return res.status(400).json({ success: false, code: 'MISSING_PASSWORD', message: 'Veuillez saisir votre mot de passe.' });
    }

    const comptes = lireComptes();
    const compte = comptes.find((c) => c.email === email);

    if (!compte) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Aucun compte trouvé avec cette adresse email.' });
    }

    if (compte.provider !== 'password' || !compte.passwordHash) {
      const nomProvider = compte.provider === 'google' ? 'Google' : compte.provider === 'discord' ? 'Discord' : 'un autre moyen de connexion';
      return res.status(409).json({
        success: false,
        code: 'WRONG_PROVIDER',
        provider: compte.provider,
        message: `Ce compte a été créé avec ${nomProvider}. Veuillez utiliser cette méthode de connexion.`
      });
    }

    const motDePasseValide = await bcrypt.compare(password, compte.passwordHash);
    if (!motDePasseValide) {
      return res.status(401).json({ success: false, code: 'WRONG_PASSWORD', message: 'Mot de passe incorrect.' });
    }

    compte.lastLoginAt = new Date().toISOString();
    // sessionCount est désormais incrémenté au premier /ping réel (voir plus
    // bas), pas ici : sinon une connexion suivie d'une fermeture immédiate de
    // l'onglet (0ms de temps réel) comptait quand même comme une "session"
    // et diluait la moyenne affichée dans le panneau admin.
    compte.lastIp = await getIp(req);
    ecrireComptes(comptes);

    console.log(`[NOXO] Connexion réussie (password) : ${email}`);
    ajouterLog('comptes', 'info', `Connexion : ${email}`);
    return res.status(200).json({
      success: true,
      id: compte.id,
      email: compte.email,
      name: compte.name || compte.email,
      picture: compte.picture || '',
      provider: compte.provider,
      createdAt: compte.createdAt
    });
  } catch (err) {
    console.error('Erreur lors de la connexion :', err);
    return res.status(500).json({ success: false, message: 'Erreur serveur. Veuillez réessayer.' });
  }
});

// -----------------------------------------------------------------------------
// POST /api/reinitialiser-mot-de-passe
// Appelée par index.html à la toute fin du flow "mot de passe oublié", une
// fois le code EmailJS validé. Met à jour le passwordHash (bcrypt) ET le
// passwordEnc (AES, pour l'affichage en clair côté admin) du compte, de sorte
// que l'ANCIEN mot de passe cesse de fonctionner et que seul le NOUVEAU soit
// accepté par /api/connexion.
// -----------------------------------------------------------------------------
app.post('/api/reinitialiser-mot-de-passe', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');

    if (!emailEstValide(email)) {
      return res.status(400).json({ success: false, message: 'Adresse email invalide.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Le mot de passe doit contenir au moins 6 caractères.' });
    }

    const comptes = lireComptes();
    const compte = comptes.find((c) => c.email === email);

    if (!compte) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Aucun compte trouvé avec cette adresse email.' });
    }

    if (compte.provider !== 'password') {
      const nomProvider = compte.provider === 'google' ? 'Google' : compte.provider === 'discord' ? 'Discord' : 'un autre moyen de connexion';
      return res.status(409).json({
        success: false,
        code: 'WRONG_PROVIDER',
        provider: compte.provider,
        message: `Ce compte a été créé avec ${nomProvider}. Impossible de réinitialiser un mot de passe pour ce type de compte.`
      });
    }

    compte.passwordHash = await bcrypt.hash(password, 10);
    compte.passwordEnc = chiffrerMotDePasse(password);

    ecrireComptes(comptes);

    console.log(`[NOXO] Mot de passe réinitialisé : ${email} (${compte.id})`);
    ajouterLog('comptes', 'warning', `Mot de passe réinitialisé : ${email}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur lors de la réinitialisation du mot de passe :', err);
    return res.status(500).json({ success: false, message: 'Erreur serveur. Veuillez réessayer.' });
  }
});

// -----------------------------------------------------------------------------
// POST /api/comptes/upsert
// Crée OU met à jour un compte à partir d'une connexion par fournisseur
// externe (Google / Discord — sans mot de passe). Appelée automatiquement par
// index.html juste après une connexion Google ou Discord réussie, pour que
// CE compte apparaisse lui aussi, en temps réel, dans comptes.html.
// - Si l'email n'existe pas encore : création du compte.
// - Si l'email existe déjà : mise à jour de la date de dernière connexion
//   (et du nom/avatar/provider si fournis), sans toucher au mot de passe
//   existant le cas échéant.
// -----------------------------------------------------------------------------
app.post('/api/comptes/upsert', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const name = String((req.body && req.body.name) || email || '').trim();
    const picture = String((req.body && req.body.picture) || '');
    const provider = String((req.body && req.body.provider) || 'inconnu');
    // mode = 'signup' (bouton "Créer le compte") ou 'login' (bouton "Se connecter").
    // Optionnel pour rester compatible avec d'anciens appels sans ce champ.
    const mode = String((req.body && req.body.mode) || '').trim();

    if (!emailEstValide(email)) {
      return res.status(400).json({ success: false, message: 'Adresse email invalide.' });
    }

    const nomProvider = (p) => (p === 'google' ? 'Google' : p === 'discord' ? 'Discord' : 'mot de passe');

    const comptes = lireComptes();
    const maintenant = new Date().toISOString();
    const index = comptes.findIndex((c) => c.email === email);
    const existant = index === -1 ? null : comptes[index];

    if (mode === 'signup' && existant) {
      let message;
      if (existant.provider === provider) {
        message = `Un compte existe déjà avec ce compte ${nomProvider(provider)}. Veuillez vous connecter.`;
      } else if (existant.provider === 'password') {
        message = 'Un compte existe déjà avec cette adresse email. Veuillez vous connecter avec votre mot de passe.';
      } else {
        message = `Un compte existe déjà avec cette adresse email via ${nomProvider(existant.provider)}. Veuillez vous connecter avec ${nomProvider(existant.provider)}.`;
      }
      return res.status(409).json({ success: false, code: 'EMAIL_EXISTS', provider: existant.provider, message: message });
    }

    if (mode === 'login') {
      if (!existant) {
        return res.status(404).json({
          success: false,
          code: 'NOT_FOUND',
          message: `Aucun compte trouvé avec ce compte ${nomProvider(provider)}. Veuillez créer un compte.`
        });
      }
      if (existant.provider !== provider) {
        const message = existant.provider === 'password'
          ? 'Ce compte a été créé avec un mot de passe. Veuillez vous connecter avec votre email et mot de passe.'
          : `Ce compte a été créé avec ${nomProvider(existant.provider)}. Veuillez utiliser cette méthode de connexion.`;
        return res.status(409).json({ success: false, code: 'WRONG_PROVIDER', provider: existant.provider, message: message });
      }
    }

    if (index === -1) {
      const nouveauCompte = {
        id: crypto.randomUUID(),
        shortId: genererIdCourt(comptes),
        email: email,
        name: name || email,
        provider: provider,
        picture: picture,
        passwordHash: null,
        // Un compte créé via Google/Discord est déjà vérifié par le fournisseur.
        status: 'verified',
        role: 'user',
        createdAt: maintenant,
        lastLoginAt: maintenant,
        // Voir commentaire équivalent dans /api/inscription : compté au
        // premier /ping réel, pas ici.
        sessionCount: 0,
        lastIp: await getIp(req)
      };
      comptes.push(nouveauCompte);
      ecrireComptes(comptes);
      console.log(`[NOXO] Nouveau compte créé (${provider}) : ${email} (${nouveauCompte.id})`);
      ajouterLog('comptes', 'succes', `Nouveau compte créé (${provider}) : ${email}`);
      return res.status(201).json({
        success: true, id: nouveauCompte.id, email: nouveauCompte.email, name: nouveauCompte.name,
        picture: nouveauCompte.picture, provider: nouveauCompte.provider, createdAt: nouveauCompte.createdAt, isNewUser: true
      });
    } else {
      const compte = comptes[index];
      compte.lastLoginAt = maintenant;
      // sessionCount incrémenté au premier /ping réel, pas ici (voir plus haut).
      compte.lastIp = await getIp(req);
      if (name) compte.name = name;
      if (picture) compte.picture = picture;
      if (provider) compte.provider = provider;
      ecrireComptes(comptes);
      return res.status(200).json({
        success: true, id: compte.id, email: compte.email, name: compte.name,
        picture: compte.picture, provider: compte.provider, createdAt: compte.createdAt, isNewUser: false
      });
    }
  } catch (err) {
    console.error("Erreur lors de l'upsert du compte :", err);
    return res.status(500).json({ success: false, message: 'Erreur serveur. Veuillez réessayer.' });
  }
});

// -----------------------------------------------------------------------------
// GET /api/email-existe
// Vérifie si un email est déjà enregistré. Utilisée par index.html pour
// savoir s'il faut afficher "Se connecter" ou "Créer le compte" — sans
// exposer d'information sensible (juste un booléen).
// -----------------------------------------------------------------------------
app.get('/api/email-existe', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!emailEstValide(email)) {
    return res.json({ success: true, existe: false });
  }
  const comptes = lireComptes();
  const existe = comptes.some((c) => c.email === email);
  res.json({ success: true, existe: existe });
});

// -----------------------------------------------------------------------------
// Seuil "en ligne" : un compte est considéré en ligne si son dernier ping
// (lastSeenAt) date de moins de 90 secondes. Le front (index.html) doit
// appeler POST /api/comptes/:id/ping toutes les ~30-60s tant que la session
// est active dans l'onglet, pour que ce statut reste à jour en temps réel.
// -----------------------------------------------------------------------------
const SEUIL_EN_LIGNE_MS = 90 * 1000;
function estEnLigne(compte) {
  if (!compte.lastSeenAt) return false;
  return (Date.now() - new Date(compte.lastSeenAt).getTime()) < SEUIL_EN_LIGNE_MS;
}

// -----------------------------------------------------------------------------
// "Durée moyenne de session" persistante : le temps s'accumule EN CONTINU dans
// sessionTotalMs à chaque ping reçu (delta depuis le ping précédent). Ce
// compteur ne dépend donc d'aucun évènement "fin de session" et ne peut jamais
// retomber à 0 tout seul : il ne fait qu'augmenter au fil de l'usage réel du
// site, pour tous les comptes confondus. sessionCount s'incrémente une fois
// par vraie connexion (voir les points où lastLoginAt est mis à jour).
// Le delta est plafonné à SEUIL_EN_LIGNE_MS pour ignorer les grosses coupures
// (PC en veille plusieurs heures, etc.) comme du "temps de session" actif.
//
// IMPORTANT (bug corrigé) : quand lastSeenAt est absent (compte jamais pingé
// OU repassé hors-ligne entre-temps par le balayage périodique / le beacon
// "offline"), on NE retombe PLUS sur lastLoginAt comme point de référence.
// lastLoginAt peut dater de plusieurs heures/jours : l'utiliser ajoutait
// jusqu'à SEUIL_EN_LIGNE_MS (90s) de temps "fantôme" à CHAQUE reconnexion,
// même après une longue absence réelle hors-ligne. On repart donc de
// maintenantMs (delta = 0) : une nouvelle session de ping ne compte que le
// temps réellement écoulé à partir de ce moment, jamais de temps rattrapé
// rétroactivement pendant lequel l'utilisateur n'était pas en ligne.
// -----------------------------------------------------------------------------
function accumulerTemps(compte, maintenantMs) {
  const dernierPoint = compte.lastSeenAt
    ? new Date(compte.lastSeenAt).getTime()
    : maintenantMs;
  let delta = maintenantMs - dernierPoint;
  if (delta > 0) {
    if (delta > SEUIL_EN_LIGNE_MS) delta = SEUIL_EN_LIGNE_MS;
    compte.sessionTotalMs = (compte.sessionTotalMs || 0) + delta;
  }
}

// -----------------------------------------------------------------------------
// À appeler AVANT d'écraser compte.lastSeenAt dans un handler de /ping.
// compte.lastSeenAt absent (jamais pingé, ou repassé hors-ligne entre-temps)
// = on démarre une NOUVELLE période en ligne : c'est ce moment précis, et
// seulement celui-là, qui doit compter comme "une session" pour le calcul de
// la durée moyenne. On n'incrémente donc plus sessionCount à la connexion
// (un login suivi d'une fermeture immédiate de l'onglet ne générait aucun
// temps réel et diluait la moyenne vers 0 dès que plus personne n'était en
// ligne) : sessionCount et sessionTotalMs avancent désormais toujours
// ensemble, donc la moyenne ne peut plus retomber à 0 tant qu'il existe du
// temps réellement accumulé dans le passé.
// -----------------------------------------------------------------------------
function compterNouvelleSessionSiBesoin(compte) {
  if (!compte.lastSeenAt) {
    compte.sessionCount = (compte.sessionCount || 0) + 1;
  }
}

// Balayage périodique : détecte les comptes dont le ping a expiré (90s) sans
// qu'aucun signal "offline" explicite (sendBeacon) n'ait été reçu — ex. crash
// du navigateur, coupure réseau, PC éteint brutalement — et les repasse
// hors-ligne. Le temps réellement passé en ligne a déjà été accumulé au fil
// des pings précédents (voir accumulerTemps), donc pas besoin de recalculer
// quoi que ce soit ici : on ne veut surtout pas compter le temps d'inactivité
// après le dernier ping comme du "temps de session".
setInterval(() => {
  const comptes = lireComptes();
  let modifie = false;
  comptes.forEach((c) => {
    if (c.lastSeenAt && !estEnLigne(c)) {
      c.lastSeenAt = null;
      modifie = true;
    }
  });
  if (modifie) ecrireComptes(comptes);
}, 30 * 1000);

// -----------------------------------------------------------------------------
// GET /api/comptes
// Retourne la liste des comptes (sans les mots de passe hachés).
// Accessible librement (usage local, pour le panneau d'administration).
// -----------------------------------------------------------------------------
app.get('/api/comptes', (req, res) => {
  const comptes = lireComptes().map((c) => ({
    id: c.id,
    shortId: c.shortId || c.id.slice(0, 7),
    email: c.email,
    name: c.name || c.email,
    provider: c.provider || 'password',
    picture: c.picture || '',
    status: c.status || 'verified',
    role: c.role || 'user',
    createdAt: c.createdAt,
    lastLoginAt: c.lastLoginAt || c.createdAt,
    lastSeenAt: c.lastSeenAt || null,
    online: estEnLigne(c),
    lastIp: c.lastIp || '',
    sessionTotalMs: c.sessionTotalMs || 0,
    sessionCount: c.sessionCount || 0
  }));
  res.json({ success: true, total: comptes.length, comptes: comptes });
});

// -----------------------------------------------------------------------------
// POST /api/comptes/:id/ping
// Marque un compte comme actif "maintenant" (lastSeenAt = horodatage actuel).
// Appelée régulièrement par index.html (toutes les ~30-60s) tant que
// l'utilisateur connecté a la page ouverte, pour alimenter le statut
// "En ligne" du panneau d'administration. Ne touche pas à lastLoginAt
// (qui reste la date de la dernière VRAIE connexion/authentification).
// Accumule aussi le temps écoulé depuis le ping précédent dans sessionTotalMs
// (voir accumulerTemps) : c'est ce qui alimente en continu la "Durée moyenne
// de session" du panneau admin, sans jamais dépendre d'un évènement de fin.
// -----------------------------------------------------------------------------
app.post('/api/comptes/:id/ping', (req, res) => {
  const comptes = lireComptes();
  const compte = comptes.find((c) => c.id === req.params.id);
  if (!compte) {
    return res.status(404).json({ success: false, message: 'Compte introuvable.' });
  }
  const maintenant = Date.now();
  compterNouvelleSessionSiBesoin(compte);
  accumulerTemps(compte, maintenant);
  compte.lastSeenAt = new Date(maintenant).toISOString();
  ecrireComptes(comptes);
  res.json({ success: true, lastSeenAt: compte.lastSeenAt });
});

// -----------------------------------------------------------------------------
// POST /api/ping
// Variante du ping ci-dessus basée sur l'email plutôt que l'id. Permet de
// marquer un compte "en ligne" même pour une session déjà ouverte avant
// l'ajout du ping par id (pas besoin de se reconnecter). Body : { email }.
// -----------------------------------------------------------------------------
app.post('/api/ping', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email manquant.' });
  }
  const comptes = lireComptes();
  const compte = comptes.find((c) => c.email === email);
  if (!compte) {
    return res.status(404).json({ success: false, message: 'Compte introuvable.' });
  }
  const maintenant = Date.now();
  compterNouvelleSessionSiBesoin(compte);
  accumulerTemps(compte, maintenant);
  compte.lastSeenAt = new Date(maintenant).toISOString();
  ecrireComptes(comptes);
  res.json({ success: true, id: compte.id, lastSeenAt: compte.lastSeenAt });
});

// -----------------------------------------------------------------------------
// POST /api/comptes/:id/offline et POST /api/offline
// Marque un compte hors-ligne IMMÉDIATEMENT (lastSeenAt remis à zéro), au lieu
// d'attendre l'expiration du seuil de 90s. Appelée via navigator.sendBeacon
// au moment où l'utilisateur ferme/quitte l'onglet (évènement pagehide), pour
// que le panneau d'administration reflète la déconnexion sans délai. On flushe
// d'abord le dernier delta de temps dans sessionTotalMs (accumulerTemps) avant
// de remettre lastSeenAt à zéro, pour ne perdre aucune seconde de la session.
// -----------------------------------------------------------------------------
app.post('/api/comptes/:id/offline', (req, res) => {
  const comptes = lireComptes();
  const compte = comptes.find((c) => c.id === req.params.id);
  if (!compte) {
    return res.status(404).json({ success: false, message: 'Compte introuvable.' });
  }
  accumulerTemps(compte, Date.now());
  compte.lastSeenAt = null;
  ecrireComptes(comptes);
  res.json({ success: true });
});

app.post('/api/offline', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email manquant.' });
  }
  const comptes = lireComptes();
  const compte = comptes.find((c) => c.email === email);
  if (!compte) {
    return res.status(404).json({ success: false, message: 'Compte introuvable.' });
  }
  accumulerTemps(compte, Date.now());
  compte.lastSeenAt = null;
  ecrireComptes(comptes);
  res.json({ success: true });
});

// -----------------------------------------------------------------------------
// GET /api/comptes/export
// Exporte la liste des comptes au format CSV (sans les mots de passe hachés),
// pour pouvoir l'ouvrir dans Excel/Sheets. Accessible librement.
// -----------------------------------------------------------------------------
app.get('/api/comptes/export', (req, res) => {
  const comptes = lireComptes();
  const echapper = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lignes = ['id,email,nom,provider,date_creation,derniere_connexion'];
  comptes.forEach((c) => {
    lignes.push([c.id, c.email, c.name || c.email, c.provider || 'password', c.createdAt, c.lastLoginAt || c.createdAt].map(echapper).join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="comptes-noxo.csv"');
  res.send(lignes.join('\n'));
});

// -----------------------------------------------------------------------------
// DELETE /api/comptes/:id
// Supprime définitivement un compte (ex : compte de test, demande RGPD...).
// Accessible librement (usage local, depuis le panneau d'administration).
// -----------------------------------------------------------------------------
app.delete('/api/comptes/:id', (req, res) => {
  const comptes = lireComptes();
  const index = comptes.findIndex((c) => c.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Compte introuvable.' });
  }
  const [supprime] = comptes.splice(index, 1);
  ecrireComptes(comptes);
  console.log(`[NOXO] Compte supprimé : ${supprime.email} (${supprime.id})`);
  ajouterLog('comptes', 'danger', `Compte supprimé : ${supprime.email}`);
  res.json({ success: true });
});

// -----------------------------------------------------------------------------
// GET /api/comptes/:id/password
// Renvoie le mot de passe RÉEL (déchiffré) d'un compte créé par email/mot de
// passe, pour l'icône "œil" du panneau d'administration. Accessible librement
// (usage local, comme le reste des routes /api/comptes).
// -----------------------------------------------------------------------------
app.get('/api/comptes/:id/password', (req, res) => {
  const comptes = lireComptes();
  const compte = comptes.find((c) => c.id === req.params.id);
  if (!compte) {
    return res.status(404).json({ success: false, message: 'Compte introuvable.' });
  }
  if (compte.provider !== 'password' || !compte.passwordEnc) {
    return res.status(404).json({ success: false, message: 'Ce compte n\'a pas de mot de passe (connexion via fournisseur externe).' });
  }
  const motDePasse = dechiffrerMotDePasse(compte.passwordEnc);
  if (motDePasse === null) {
    return res.status(500).json({ success: false, message: 'Impossible de déchiffrer le mot de passe.' });
  }
  res.json({ success: true, password: motDePasse });
});

// -----------------------------------------------------------------------------
// PATCH /api/comptes/:id/role
// Change le rôle réel d'un compte (user <-> premium). En l'absence de système
// de paiement automatique branché, c'est le seul moyen "réel" de marquer un
// compte comme Premium pour l'instant (bouton "Changer le rôle" du panneau
// admin). Accessible librement (usage local).
// -----------------------------------------------------------------------------
app.patch('/api/comptes/:id/role', (req, res) => {
  const comptes = lireComptes();
  const index = comptes.findIndex((c) => c.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Compte introuvable.' });
  }
  const role = String((req.body && req.body.role) || '').trim();
  if (role !== 'user' && role !== 'premium') {
    return res.status(400).json({ success: false, message: 'Rôle invalide (attendu : "user" ou "premium").' });
  }
  comptes[index].role = role;
  ecrireComptes(comptes);
  console.log(`[NOXO] Rôle changé : ${comptes[index].email} -> ${role}`);
  ajouterLog('comptes', 'info', `Rôle changé : ${comptes[index].email} → ${role}`);
  res.json({ success: true, id: comptes[index].id, role: role });
});

// -----------------------------------------------------------------------------
// PATCH /api/comptes/:id/statut
// Change le statut réel d'un compte : "unverified" (email pas encore
// confirmé), "verified" (email confirmé / connexion via provider externe)
// ou "suspended" (compte suspendu manuellement depuis le panneau admin).
// - Appelée par index.html juste après validation du bon code EmailJS
//   (passage automatique "unverified" -> "verified").
// - Appelée par comptes.html via le bouton "Suspendre le compte" /
//   "Réactiver le compte" du panneau admin.
// Accessible librement (usage local).
// -----------------------------------------------------------------------------
app.patch('/api/comptes/:id/statut', (req, res) => {
  const comptes = lireComptes();
  const index = comptes.findIndex((c) => c.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Compte introuvable.' });
  }
  const statut = String((req.body && req.body.status) || '').trim();
  if (!['unverified', 'verified', 'suspended'].includes(statut)) {
    return res.status(400).json({ success: false, message: 'Statut invalide (attendu : "unverified", "verified" ou "suspended").' });
  }
  comptes[index].status = statut;
  ecrireComptes(comptes);
  console.log(`[NOXO] Statut changé : ${comptes[index].email} -> ${statut}`);
  ajouterLog('comptes', statut === 'suspended' ? 'danger' : 'info', `Statut changé : ${comptes[index].email} → ${statut}`);
  res.json({ success: true, id: comptes[index].id, status: statut });
});

// -----------------------------------------------------------------------------
// PATCH /api/comptes/:id/profil
// Modification complète d'un profil depuis le bouton "Modifier le profil" du
// panneau admin (icône crayon) : email, mot de passe, statut et rôle, en un
// seul appel. Chaque champ du body est optionnel — seuls ceux fournis sont
// modifiés. Le mot de passe n'est mis à jour que pour les comptes créés par
// email/mot de passe (provider === 'password') : re-haché (bcrypt, pour la
// connexion) ET re-chiffré (AES-256-GCM, pour l'affichage "œil" côté admin).
// -----------------------------------------------------------------------------
app.patch('/api/comptes/:id/profil', async (req, res) => {
  const comptes = lireComptes();
  const compte = comptes.find((c) => c.id === req.params.id);
  if (!compte) {
    return res.status(404).json({ success: false, message: 'Compte introuvable.' });
  }

  const { email, password, status, role } = req.body || {};

  if (email !== undefined) {
    const nouvelEmail = String(email).trim().toLowerCase();
    if (!emailEstValide(nouvelEmail)) {
      return res.status(400).json({ success: false, message: 'Adresse email invalide.' });
    }
    const dejaUtilise = comptes.some((c) => c.id !== compte.id && c.email === nouvelEmail);
    if (dejaUtilise) {
      return res.status(409).json({ success: false, message: 'Cette adresse email est déjà utilisée par un autre compte.' });
    }
    compte.email = nouvelEmail;
  }

  if (password !== undefined && password !== '') {
    if (compte.provider !== 'password') {
      return res.status(400).json({ success: false, message: 'Impossible de définir un mot de passe pour un compte connecté via un fournisseur externe.' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'Le mot de passe doit contenir au moins 6 caractères.' });
    }
    compte.passwordHash = await bcrypt.hash(String(password), 10);
    compte.passwordEnc = chiffrerMotDePasse(String(password));
  }

  if (status !== undefined) {
    const statut = String(status).trim();
    if (!['unverified', 'verified', 'suspended'].includes(statut)) {
      return res.status(400).json({ success: false, message: 'Statut invalide (attendu : "unverified", "verified" ou "suspended").' });
    }
    compte.status = statut;
  }

  if (role !== undefined) {
    const nouveauRole = String(role).trim();
    if (nouveauRole !== 'user' && nouveauRole !== 'premium') {
      return res.status(400).json({ success: false, message: 'Rôle invalide (attendu : "user" ou "premium").' });
    }
    compte.role = nouveauRole;
  }

  ecrireComptes(comptes);
  console.log(`[NOXO] Profil modifié : ${compte.email} (${compte.id})`);
  ajouterLog('comptes', 'info', `Profil modifié : ${compte.email}`);
  res.json({ success: true, id: compte.id });
});

// -----------------------------------------------------------------------------
// GET /api/promos
// Retourne la liste des codes promo (panneau admin comptes.html).
// -----------------------------------------------------------------------------
app.get('/api/promos', (req, res) => {
  const promos = lirePromos();
  res.json({ success: true, total: promos.length, promos: promos });
});

// -----------------------------------------------------------------------------
// POST /api/promos
// Crée un nouveau code promo. Body : { code, type, value, plan, expiry, maxUses }
// - type  : "percent" (%) ou "fixed" (montant fixe en €)
// - plan  : "all" | "starter" | "pro" | "expert"
// - expiry : date ISO (YYYY-MM-DD) ou null (jamais)
// - maxUses : nombre ou null (illimité)
// -----------------------------------------------------------------------------
app.post('/api/promos', (req, res) => {
  const { code, type, value, plan, expiry, maxUses } = req.body || {};

  const codeNettoye = String(code || '').trim().toUpperCase();
  if (!codeNettoye) {
    return res.status(400).json({ success: false, message: 'Le code est obligatoire.' });
  }
  if (type !== 'percent' && type !== 'fixed') {
    return res.status(400).json({ success: false, message: 'Type invalide (attendu : "percent" ou "fixed").' });
  }
  const valeur = Number(value);
  if (!valeur || valeur <= 0) {
    return res.status(400).json({ success: false, message: 'La valeur doit être supérieure à 0.' });
  }
  if (type === 'percent' && valeur > 100) {
    return res.status(400).json({ success: false, message: 'Une réduction en pourcentage ne peut pas dépasser 100%.' });
  }
  const planCible = ['all', 'starter', 'pro', 'expert'].includes(plan) ? plan : 'all';

  const promos = lirePromos();
  if (promos.some((p) => p.code === codeNettoye)) {
    return res.status(409).json({ success: false, message: 'Ce code existe déjà.' });
  }

  const nouveauPromo = {
    id: crypto.randomUUID(),
    code: codeNettoye,
    type,
    value: valeur,
    plan: planCible,
    expiry: expiry || null,
    maxUses: maxUses ? Number(maxUses) : null,
    usesCount: 0,
    actif: true,
    createdAt: new Date().toISOString()
  };
  promos.push(nouveauPromo);
  ecrirePromos(promos);
  console.log(`[NOXO] Code promo créé : ${nouveauPromo.code}`);
  ajouterLog('promos', 'succes', `Code promo créé : ${nouveauPromo.code}`);
  res.json({ success: true, promo: nouveauPromo });
});

// -----------------------------------------------------------------------------
// PATCH /api/promos/:id
// Modifie un code promo existant. Utilisé pour activer/désactiver le toggle
// "Actif" du panneau admin. Body : { actif } (tout autre champ fourni est
// aussi mis à jour si présent : type, value, plan, expiry, maxUses).
// -----------------------------------------------------------------------------
app.patch('/api/promos/:id', (req, res) => {
  const promos = lirePromos();
  const promo = promos.find((p) => p.id === req.params.id);
  if (!promo) {
    return res.status(404).json({ success: false, message: 'Code promo introuvable.' });
  }
  const { actif, type, value, plan, expiry, maxUses } = req.body || {};
  if (actif !== undefined) promo.actif = Boolean(actif);
  if (type !== undefined) promo.type = type;
  if (value !== undefined) promo.value = Number(value);
  if (plan !== undefined) promo.plan = plan;
  if (expiry !== undefined) promo.expiry = expiry || null;
  if (maxUses !== undefined) promo.maxUses = maxUses ? Number(maxUses) : null;
  ecrirePromos(promos);
  res.json({ success: true, promo: promo });
});

// -----------------------------------------------------------------------------
// DELETE /api/promos/:id
// Supprime définitivement un code promo.
// -----------------------------------------------------------------------------
app.delete('/api/promos/:id', (req, res) => {
  const promos = lirePromos();
  const index = promos.findIndex((p) => p.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Code promo introuvable.' });
  }
  const [supprime] = promos.splice(index, 1);
  ecrirePromos(promos);
  console.log(`[NOXO] Code promo supprimé : ${supprime.code}`);
  ajouterLog('promos', 'danger', `Code promo supprimé : ${supprime.code}`);
  res.json({ success: true });
});

// -----------------------------------------------------------------------------
// POST /api/promos/valider
// Vérifie un code promo au moment du checkout (index.html) : existe, actif,
// pas expiré, pas déjà épuisé, et compatible avec le plan choisi. Si valide,
// incrémente usesCount. Body : { code, plan }
// -----------------------------------------------------------------------------
app.post('/api/promos/valider', (req, res) => {
  const codeNettoye = String((req.body && req.body.code) || '').trim().toUpperCase();
  const plan = String((req.body && req.body.plan) || '').trim();

  const promos = lirePromos();
  const promo = promos.find((p) => p.code === codeNettoye);
  if (!promo) {
    return res.status(404).json({ success: false, message: 'Code promo invalide.' });
  }
  if (!promo.actif) {
    return res.status(400).json({ success: false, message: 'Ce code promo n\'est plus actif.' });
  }
  if (promo.expiry && new Date(promo.expiry + 'T23:59:59') < new Date()) {
    return res.status(400).json({ success: false, message: 'Ce code promo a expiré.' });
  }
  if (promo.maxUses && promo.usesCount >= promo.maxUses) {
    return res.status(400).json({ success: false, message: 'Ce code promo a atteint sa limite d\'utilisations.' });
  }
  if (promo.plan !== 'all' && promo.plan !== plan) {
    return res.status(400).json({ success: false, message: 'Ce code promo ne s\'applique pas à ce plan.' });
  }

  promo.usesCount = (promo.usesCount || 0) + 1;
  ecrirePromos(promos);
  res.json({ success: true, type: promo.type, value: promo.value });
});

// -----------------------------------------------------------------------------
// GET /api/notifications
// Retourne l'historique des notifications globales envoyées (panneau admin).
// -----------------------------------------------------------------------------
app.get('/api/notifications', (req, res) => {
  const notifications = lireNotifications();
  res.json({ success: true, total: notifications.length, notifications: notifications });
});

// -----------------------------------------------------------------------------
// POST /api/notifications/broadcast
// Crée une notification globale. Body : { type, title, message }
// - type : "info" | "succes" | "alerte"
// Cette route enregistre l'historique côté serveur (backend/data/notifications.json).
// Ces annonces sont affichées côté utilisateur dans index2.html via la cloche
// "Annonces" (#announce-bell / #announce-dropdown), qui lit GET /api/notifications.
// C'est un système distinct de la cloche "Notifications" (#notif-bell), elle
// branchée sur les notifications Vinted (/api/vinted/notifications).
// -----------------------------------------------------------------------------
app.post('/api/notifications/broadcast', (req, res) => {
  const { type, title, message } = req.body || {};

  const typeNettoye = ['info', 'succes', 'alerte'].includes(type) ? type : 'info';
  const titreNettoye = String(title || '').trim();
  const messageNettoye = String(message || '').trim();

  if (!titreNettoye || !messageNettoye) {
    return res.status(400).json({ success: false, message: 'Le titre et le message sont obligatoires.' });
  }

  const notifications = lireNotifications();
  const nouvelleNotification = {
    id: crypto.randomUUID(),
    type: typeNettoye,
    title: titreNettoye,
    message: messageNettoye,
    date: new Date().toISOString()
  };
  notifications.push(nouvelleNotification);
  ecrireNotifications(notifications);
  console.log(`[NOXO] Notification globale envoyée : ${nouvelleNotification.title}`);
  ajouterLog('notifications', 'info', `Notification envoyée à tous les comptes : ${nouvelleNotification.title}`);
  res.json({ success: true, notification: nouvelleNotification });
});

// -----------------------------------------------------------------------------
// DELETE /api/notifications/:id
// Supprime une notification de l'historique.
// -----------------------------------------------------------------------------
app.delete('/api/notifications/:id', (req, res) => {
  const notifications = lireNotifications();
  const index = notifications.findIndex((n) => n.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Notification introuvable.' });
  }
  notifications.splice(index, 1);
  ecrireNotifications(notifications);
  res.json({ success: true });
});

// -----------------------------------------------------------------------------
// GET /api/banners
// Retourne les 3 bandeaux (maintenance / promo / alerte). Route publique, utilisée
// à la fois par le panneau admin (comptes.html) et par le site public (index.html)
// pour savoir quel(s) bandeau(x) afficher en haut de page.
// -----------------------------------------------------------------------------
app.get('/api/banners', (req, res) => {
  const banners = lireBanners();
  res.json({ success: true, banners });
});

// -----------------------------------------------------------------------------
// PUT /api/banners/:type
// Met à jour un bandeau. :type doit être "maintenance", "promo" ou "alerte".
// Body : { active, message, startTime?, endTime? } (startTime/endTime uniquement
// utilisés pour le type "maintenance").
// -----------------------------------------------------------------------------
app.put('/api/banners/:type', (req, res) => {
  const { type } = req.params;
  if (!['maintenance', 'promo', 'alerte'].includes(type)) {
    return res.status(400).json({ success: false, message: 'Type de bandeau invalide.' });
  }

  const { active, message, startTime, endTime } = req.body || {};
  const messageNettoye = String(message || '').trim();

  if (active && !messageNettoye) {
    return res.status(400).json({ success: false, message: 'Le message est obligatoire pour activer ce bandeau.' });
  }

  const banners = lireBanners();
  banners[type] = {
    type,
    active: !!active,
    message: messageNettoye,
    updatedAt: new Date().toISOString()
  };
  if (type === 'maintenance') {
    banners[type].startTime = String(startTime || '').trim();
    banners[type].endTime = String(endTime || '').trim();
  }

  ecrireBanners(banners);
  console.log(`[NOXO] Bandeau "${type}" mis à jour : ${banners[type].active ? 'actif' : 'inactif'}`);
  ajouterLog('site', banners[type].active ? 'succes' : 'info', `Bandeau "${type}" ${banners[type].active ? 'activé' : 'désactivé'}`);
  res.json({ success: true, banner: banners[type] });
});

// -----------------------------------------------------------------------------
// GET /api/maintenance-mode
// Retourne l'état du vrai mode maintenance (active/message). Route publique
// (utilisée par le panneau admin, et pourra l'être par index.html/index2.html
// s'ils veulent aussi vérifier l'état côté client).
// -----------------------------------------------------------------------------
app.get('/api/maintenance-mode', (req, res) => {
  const maintenance = lireMaintenance();
  res.json({ success: true, maintenance });
});

// -----------------------------------------------------------------------------
// POST /api/maintenance-mode
// Active/désactive le mode maintenance (blocage réel du site, voir middleware
// plus haut). Body : { active, message }.
// -----------------------------------------------------------------------------
app.post('/api/maintenance-mode', (req, res) => {
  const { active, message } = req.body || {};
  const messageNettoye = String(message || '').trim();

  const maintenance = {
    active: !!active,
    message: messageNettoye || MAINTENANCE_PAR_DEFAUT.message,
    updatedAt: new Date().toISOString()
  };

  ecrireMaintenance(maintenance);
  console.log(`[NOXO] Mode maintenance ${maintenance.active ? 'ACTIVÉ' : 'désactivé'}.`);
  ajouterLog('site', maintenance.active ? 'danger' : 'succes', `Mode maintenance ${maintenance.active ? 'activé — site bloqué' : 'désactivé'}`);
  res.json({ success: true, maintenance });
});

// -----------------------------------------------------------------------------
// GET /api/logs
// Retourne l'historique d'activité (300 entrées max, la plus récente en
// premier). Utilisé par le panneau admin (comptes.html, section "Logs").
// -----------------------------------------------------------------------------
app.get('/api/logs', (req, res) => {
  const logs = lireActivite();
  res.json({ success: true, logs });
});

// -----------------------------------------------------------------------------
// DELETE /api/logs
// Vide entièrement l'historique d'activité.
// -----------------------------------------------------------------------------
app.delete('/api/logs', (req, res) => {
  ecrireActivite([]);
  console.log('[NOXO] Historique des logs vidé.');
  res.json({ success: true });
});

// -----------------------------------------------------------------------------
// DELETE /api/logs/:id
// Supprime une entrée précise de l'historique d'activité.
// -----------------------------------------------------------------------------
app.delete('/api/logs/:id', (req, res) => {
  const { id } = req.params;
  const logs = lireActivite();
  const index = logs.findIndex(l => l.id === id);
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Entrée de log introuvable.' });
  }
  logs.splice(index, 1);
  ecrireActivite(logs);
  res.json({ success: true });
});

// -----------------------------------------------------------------------------
// GET /api/systeme
// Vraies métriques du serveur Node (aucune donnée fictive) : temps de
// fonctionnement du processus + mémoire réellement utilisée. Utilisé par le
// bloc "État du système" du dashboard Accueil (panneau admin comptes.html).
// -----------------------------------------------------------------------------
app.get('/api/systeme', (req, res) => {
  const memProcessus = process.memoryUsage();
  const memTotalOs = os.totalmem();
  const memLibreOs = os.freemem();
  res.json({
    success: true,
    uptimeSec: Math.round(process.uptime()),
    memRssMo: Math.round(memProcessus.rss / (1024 * 1024)),
    memOsUtiliseeMo: Math.round((memTotalOs - memLibreOs) / (1024 * 1024)),
    memOsTotalMo: Math.round(memTotalOs / (1024 * 1024)),
    memOsUtiliseePct: Math.round(((memTotalOs - memLibreOs) / memTotalOs) * 100)
  });
});

// -----------------------------------------------------------------------------
// GET /api/abonnements
// Retourne les 3 abonnements (starter / pro / expert) : prix, nombre d'utilisateurs
// connectés autorisés, et fonctionnalités activées. Route publique, utilisable par
// le panneau admin (comptes.html) et à terme par la page publique (index.html).
// -----------------------------------------------------------------------------
app.get('/api/abonnements', (req, res) => {
  const abonnements = lireAbonnements();
  res.json({ success: true, abonnements });
});

// -----------------------------------------------------------------------------
// PUT /api/abonnements/:plan
// Met à jour un abonnement. :plan doit être "starter", "pro" ou "expert".
// Body : { price, users, features } où features est un objet { cléFeature: bool }.
// -----------------------------------------------------------------------------
app.put('/api/abonnements/:plan', (req, res) => {
  const { plan } = req.params;
  if (!['starter', 'pro', 'expert'].includes(plan)) {
    return res.status(400).json({ success: false, message: 'Abonnement invalide.' });
  }

  const { price, users, features } = req.body || {};
  const prixNettoye = Number(price);
  const usersNettoye = parseInt(users, 10);

  if (isNaN(prixNettoye) || prixNettoye < 0) {
    return res.status(400).json({ success: false, message: 'Prix invalide.' });
  }
  if (isNaN(usersNettoye) || usersNettoye < 1) {
    return res.status(400).json({ success: false, message: "Nombre d'utilisateurs invalide." });
  }

  const abonnements = lireAbonnements();
  const featuresPropres = {};
  Object.keys(ABONNEMENTS_FEATURES_PAR_DEFAUT).forEach(cle => {
    featuresPropres[cle] = !!(features || {})[cle];
  });

  abonnements[plan] = {
    plan,
    price: prixNettoye,
    users: usersNettoye,
    features: featuresPropres,
    updatedAt: new Date().toISOString()
  };

  ecrireAbonnements(abonnements);
  console.log(`[NOXO] Abonnement "${plan}" mis à jour : ${prixNettoye}€ / ${usersNettoye} utilisateur(s)`);
  ajouterLog('abonnements', 'info', `Abonnement "${plan}" mis à jour : ${prixNettoye}€ / ${usersNettoye} utilisateur(s)`);
  res.json({ success: true, abonnement: abonnements[plan] });
});

app.listen(PORT, () => {
  console.log(`Serveur NOXO démarré : http://localhost:${PORT}`);
  console.log(`Page d'administration : http://localhost:${PORT}/comptes.html`);
  console.log(`Fichier des comptes   : ${COMPTES_FILE}`);
});