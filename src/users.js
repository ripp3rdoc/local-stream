// User accounts: stored in data/users.json with scrypt-hashed passwords.
// Each account has its own watch progress in data/progress/<id>.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const usersFile = path.join(config.dataDir, 'users.json');
const progressDir = path.join(config.dataDir, 'progress');
// Progress from before accounts existed (and the file used when accounts are off).
const legacyProgressFile = path.join(config.dataDir, 'progress.json');

const ROLES = ['admin', 'user'];
const USERNAME_RE = /^[A-Za-z0-9._-]{1,32}$/;
const MIN_PASSWORD = 4;
const MAX_PASSWORD = 200;

let users = [];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
    users = Array.isArray(data.users) ? data.users : [];
  } catch { users = []; }
}

function save() {
  fs.mkdirSync(path.dirname(usersFile), { recursive: true });
  const tmp = `${usersFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2));
  fs.renameSync(tmp, usersFile);
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function checkPassword(user, password) {
  const salt = Buffer.from(user.salt, 'hex');
  const expected = Buffer.from(user.hash, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Spent on unknown usernames so a wrong name takes as long as a wrong password.
const DUMMY = hashPassword(crypto.randomBytes(16).toString('hex'));

function validateUsername(name) {
  if (typeof name !== 'string' || !USERNAME_RE.test(name.trim())) {
    throw httpError(400, 'Username must be 1–32 letters, numbers, dots, dashes or underscores');
  }
  return name.trim();
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) {
    throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (pw.length > MAX_PASSWORD) throw httpError(400, 'Password is too long');
  return pw;
}

function validateRole(role) {
  if (!ROLES.includes(role)) throw httpError(400, 'Role must be admin or user');
  return role;
}

const publicUser = u => (u ? { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt } : null);

function count() { return users.length; }
function list() { return users.map(publicUser); }
function get(id) { return users.find(u => u.id === id) || null; }
function findByName(name) {
  const n = String(name || '').trim().toLowerCase();
  return users.find(u => u.username.toLowerCase() === n) || null;
}
function adminCount() { return users.filter(u => u.role === 'admin').length; }
function firstAdmin() { return users.find(u => u.role === 'admin') || null; }

function authenticate(username, password) {
  const user = findByName(username);
  if (!user) {
    checkPassword(DUMMY, String(password || ''));
    return null;
  }
  return checkPassword(user, String(password || '')) ? user : null;
}

function create({ username, password, role = 'user' }) {
  const name = validateUsername(username);
  validatePassword(password);
  validateRole(role);
  if (findByName(name)) throw httpError(409, 'That username is taken');
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    username: name,
    role,
    ...hashPassword(password),
    createdAt: Date.now(),
  };
  users.push(user);
  save();
  return user;
}

function update(id, { role, password } = {}) {
  const user = get(id);
  if (!user) throw httpError(404, 'User not found');
  if (role !== undefined) {
    validateRole(role);
    if (user.role === 'admin' && role !== 'admin' && adminCount() === 1) {
      throw httpError(400, 'There must be at least one admin');
    }
  }
  if (password !== undefined) validatePassword(password);
  if (role !== undefined) user.role = role;
  if (password !== undefined) Object.assign(user, hashPassword(password));
  save();
  return user;
}

function remove(id) {
  const user = get(id);
  if (!user) throw httpError(404, 'User not found');
  if (user.role === 'admin' && adminCount() === 1) throw httpError(400, 'There must be at least one admin');
  users = users.filter(u => u !== user);
  save();
  try { fs.unlinkSync(progressFile(id)); } catch { /* no progress yet */ }
}

// --- Per-account watch progress ---------------------------------------------
function progressFile(userId) {
  if (!userId) return legacyProgressFile;
  return path.join(progressDir, `${userId.replace(/[^a-f0-9]/gi, '')}.json`);
}

function loadProgress(userId) {
  try { return JSON.parse(fs.readFileSync(progressFile(userId), 'utf-8')); } catch { return {}; }
}

function saveProgress(userId, data) {
  const file = progressFile(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// First run with accounts: turn the config.json / env login into the first
// admin, and hand them the progress recorded before accounts existed.
function bootstrap({ username, password }) {
  load();
  if (users.length || !username || !password) return null;
  // Taken as-is (no name/length rules) so an existing login always carries over.
  const admin = {
    id: crypto.randomBytes(8).toString('hex'),
    username: String(username).trim(),
    role: 'admin',
    ...hashPassword(password),
    createdAt: Date.now(),
  };
  users.push(admin);
  save();
  if (fs.existsSync(legacyProgressFile) && !fs.existsSync(progressFile(admin.id))) {
    fs.mkdirSync(progressDir, { recursive: true });
    fs.copyFileSync(legacyProgressFile, progressFile(admin.id));
  }
  return admin;
}

module.exports = {
  bootstrap,
  count,
  list,
  get,
  firstAdmin,
  authenticate,
  checkPassword,
  create,
  update,
  remove,
  publicUser,
  loadProgress,
  saveProgress,
};
