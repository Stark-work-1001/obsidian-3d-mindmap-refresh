// Single source of truth for the version is package.json. `npm version x.y.z`
// runs this script: it copies the version into manifest.json and adds (never
// replaces) the matching entry in versions.json, keeping all history.
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));
manifest.version = pkg.version;
versions[pkg.version] = manifest.minAppVersion;
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');
console.log(`version ${pkg.version} (minAppVersion ${manifest.minAppVersion}); ${Object.keys(versions).length} entries in versions.json`);
