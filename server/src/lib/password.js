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

// No 0/O, 1/l/I: easy to read off an email and type on a phone.
const SIGN_IN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/**
 * A temporary password TaskFlow hands to a person (by email or on screen):
 * 14 characters from an alphabet without look-alikes, about 80 bits.
 */
export function generateSignInPassword(length = 14) {
  const out = [];
  // rejection sampling keeps every character equally likely
  const limit = 256 - (256 % SIGN_IN_ALPHABET.length);
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out.push(SIGN_IN_ALPHABET[byte % SIGN_IN_ALPHABET.length]);
    }
  }
  return out.join('');
}
