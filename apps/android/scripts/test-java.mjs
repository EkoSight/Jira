/**
 * Runs the app's plain-Java tests without the Android SDK: the parts of the
 * TaskFlowPhone plugin that decide what leaves the phone (Numbers,
 * CallLogPicker, RecordingMatcher), against the same answers the server is
 * tested with (shared/callingVectors.json). On a machine with the SDK,
 * `cd android && ./gradlew test` runs the same tests.
 *
 * Downloads JUnit 4, Hamcrest and org.json from Maven Central into build/.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libs = path.join(root, 'build', 'test-libs');
const out = path.join(root, 'build', 'test-classes');
const JARS = {
  'junit-4.13.2.jar': 'https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.jar',
  'hamcrest-core-1.3.jar': 'https://repo1.maven.org/maven2/org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar',
  'json-20250517.jar': 'https://repo1.maven.org/maven2/org/json/json/20250517/json-20250517.jar',
};
const PURE = ['Numbers.java', 'CallLogPicker.java', 'RecordingMatcher.java'];

fs.mkdirSync(libs, { recursive: true });
for (const [name, url] of Object.entries(JARS)) {
  const file = path.join(libs, name);
  if (fs.existsSync(file)) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url}: ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
const cp = Object.keys(JARS).map((n) => path.join(libs, n)).join(path.delimiter);
const main = path.join(root, 'android/app/src/main/java/com/ekosight/taskflow/phone');
const tests = path.join(root, 'android/app/src/test/java/com/ekosight/taskflow/phone');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const sources = [...PURE.map((f) => path.join(main, f)), ...fs.readdirSync(tests).filter((f) => f.endsWith('.java')).map((f) => path.join(tests, f))];
execFileSync('javac', ['--release', '11', '-Xlint:all', '-Werror', '-d', out, '-cp', cp, ...sources], { stdio: 'inherit' });
const classes = fs.readdirSync(tests).filter((f) => f.endsWith('Test.java')).map((f) => `com.ekosight.taskflow.phone.${f.replace(/\.java$/, '')}`);
execFileSync('java', [`-Dtaskflow.vectors=${path.resolve(root, '../../shared/callingVectors.json')}`, '-cp', [out, cp].join(path.delimiter), 'org.junit.runner.JUnitCore', ...classes], { stdio: 'inherit' });
