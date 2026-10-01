/**
 * The Google Chat private key, as it ends up in .env files in practice.
 * Each way of pasting it either works or names the problem — never prints it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { readPrivateKey } from '../src/lib/googleChat.js';

const pem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const escaped = pem.replace(/\n/g, '\\n');           // exactly as it sits inside the JSON file
const fromEnv = (line) => dotenv.parse(Buffer.from(`${line}\n`)).K;
const works = (raw, label) => {
  const { key, problem } = readPrivateKey(raw);
  assert.ok(key, `${label}: ${problem}`);
  assert.doesNotThrow(() => crypto.createPrivateKey(key));
};

test('every common way of writing the key in .env is read', () => {
  works(fromEnv(`K="${escaped}"`), 'double quotes, \\n (the documented way)');
  works(fromEnv(`K='${escaped}'`), 'single quotes');
  works(fromEnv(`K=${escaped}`), 'no quotes');
  works(fromEnv(`K="${escaped}",`), 'trailing comma copied from the JSON');
  works(fromEnv(`K="\\"${escaped}\\""`), 'quotes inside quotes');
  works(pem.replace(/\n/g, '\\\\n'), 'double-escaped \\\\n');
  works(pem.replace(/\n/g, '\r\n'), 'Windows line endings');
  works(pem.replace(/\n/g, ' '), 'line breaks turned into spaces');
  works(pem.replace(/\n/g, ''), 'line breaks removed');
  works(escaped.replace(/\\n/g, 'n'), 'backslashes stripped by a service manager');
  works(`"private_key": "${escaped}",`, 'the whole JSON line pasted');
  works(Buffer.from(pem).toString('base64'), 'base64-encoded key');
  works(fromEnv(`K="${pem}"`), 'real line breaks inside double quotes');
});

test('a broken key says what is wrong, without showing the key', () => {
  const cutOff = fromEnv(`K=${pem}`); // pasted over several lines with no quotes: only the first line survives
  assert.match(readPrivateKey(cutOff).problem, /cut off/);
  assert.match(readPrivateKey('').problem, /empty or missing/);
  assert.match(readPrivateKey('abc').problem, /does not start with/);
  const body = escaped.split('\\n');
  const damaged = [...body.slice(0, 5), ...body.slice(7)].join('\\n');
  const { problem } = readPrivateKey(damaged);
  assert.match(problem, /incomplete or altered/);
  for (const p of [readPrivateKey(cutOff).problem, problem]) assert.ok(!p.includes(body[2]), 'no key text in the message');
});
