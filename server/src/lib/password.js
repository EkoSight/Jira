import crypto from 'node:crypto';

// scrypt from Node's stdlib — no native build step, which keeps deployment of the
// module into the existing app painless.
const KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, SCRYPT_OPTS, (err, derived) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString('hex')}$${derived.toString('hex')}`);
    });
  });
}

export function verifyPassword(password, stored) {
  if (!stored) return Promise.resolve(false);
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return Promise.resolve(false);

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');

  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, SCRYPT_OPTS, (err, derived) => {
      if (err) return reject(err);
      resolve(crypto.timingSafeEqual(expected, derived));
    });
  });
}

export function generateTempPassword() {
  return crypto.randomBytes(6).toString('base64url');
}
