const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const config = require('./config');

const certDir = path.join(config.dataDir, 'certs');
const caCertPath = path.join(certDir, 'ca.pem');
const caKeyPath = path.join(certDir, 'ca-key.pem');
const certPath = path.join(certDir, 'cert.pem');
const keyPath = path.join(certDir, 'key.pem');
const metaPath = path.join(certDir, 'sans.json');

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

// Load the local CA, generating it once if missing. Devices install this CA so
// the server's certificate (signed by it) is trusted with no warning.
function loadOrCreateCA() {
  if (fs.existsSync(caCertPath) && fs.existsSync(caKeyPath)) {
    return {
      cert: forge.pki.certificateFromPem(fs.readFileSync(caCertPath, 'utf-8')),
      key: forge.pki.privateKeyFromPem(fs.readFileSync(caKeyPath, 'utf-8')),
    };
  }

  fs.mkdirSync(certDir, { recursive: true });
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = daysFromNow(-1);
  cert.validity.notAfter = daysFromNow(3650);
  const attrs = [
    { name: 'commonName', value: 'Local Stream Local CA' },
    { name: 'organizationName', value: 'Local Stream' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed root
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  fs.writeFileSync(caCertPath, forge.pki.certificateToPem(cert));
  fs.writeFileSync(caKeyPath, forge.pki.privateKeyToPem(keys.privateKey));
  return { cert, key: keys.privateKey };
}

// Issue a server (leaf) certificate signed by the CA, valid for localhost,
// 127.0.0.1, and the LAN IP. Cached and reused unless the SAN set changes.
function makeLeaf(ca, lanIP, wantedSans) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = daysFromNow(-1);
  cert.validity.notAfter = daysFromNow(1825);
  cert.setSubject([{ name: 'commonName', value: lanIP || 'localhost' }]);
  cert.setIssuer(ca.cert.subject.attributes);

  const altNames = [
    { type: 2, value: 'localhost' }, // DNS
    { type: 7, ip: '127.0.0.1' },    // IP
  ];
  if (lanIP && lanIP !== 'localhost') altNames.push({ type: 7, ip: lanIP });

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(certPath, forge.pki.certificateToPem(cert));
  fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey));
  fs.writeFileSync(metaPath, JSON.stringify({ sans: wantedSans }, null, 2));
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

async function ensureCert(lanIP) {
  const ca = loadOrCreateCA();
  const wantedSans = ['localhost', '127.0.0.1'];
  if (lanIP && lanIP !== 'localhost') wantedSans.push(lanIP);

  // Reuse the cached leaf unless the SAN set (i.e. the LAN IP) changed.
  if (fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.existsSync(metaPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (JSON.stringify(prev.sans) === JSON.stringify(wantedSans)) {
        return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
      }
    } catch { /* regenerate */ }
  }

  return makeLeaf(ca, lanIP, wantedSans);
}

function caCertFile() {
  return caCertPath;
}

module.exports = { ensureCert, caCertFile };
