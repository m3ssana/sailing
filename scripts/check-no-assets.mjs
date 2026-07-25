#!/usr/bin/env node
/**
 * Enforces requirement 7.14 / 9.6: all content is generated procedurally.
 *
 * The build must contain no mesh files, no raster textures and no audio files.
 * A small allowance exists for utility data (e.g. a blue-noise tile) under a
 * hard size cap, because such data is not art — it is a numeric lookup.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { existsSync } from 'node:fs';

const DIST = 'dist';

/** Extensions that would indicate an imported art asset. */
const FORBIDDEN = new Set([
  // meshes
  '.gltf', '.glb', '.obj', '.fbx', '.dae', '.3ds', '.blend', '.ply', '.stl',
  // textures
  '.png', '.jpg', '.jpeg', '.webp', '.avif', '.ktx', '.ktx2', '.basis', '.dds',
  '.tga', '.bmp', '.exr', '.hdr', '.tiff', '.tif',
  // audio
  '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus',
  // video
  '.mp4', '.webm', '.mov',
]);

/** Utility data permitted under UTILITY_MAX_BYTES. */
const UTILITY_ALLOWLIST = [/blue-?noise/i, /favicon/i];
const UTILITY_MAX_BYTES = 64 * 1024;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function main() {
  if (!existsSync(DIST)) {
    console.error(`✗ ${DIST}/ not found. Run \`npm run build\` first.`);
    process.exit(1);
  }

  const files = await walk(DIST);
  const violations = [];
  const allowed = [];

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!FORBIDDEN.has(ext)) continue;

    const rel = relative(DIST, file);
    const { size } = await stat(file);
    const isUtility = UTILITY_ALLOWLIST.some((re) => re.test(rel));

    if (isUtility && size <= UTILITY_MAX_BYTES) {
      allowed.push(`${rel} (${size} B, utility)`);
    } else {
      violations.push(
        `${rel} (${size} B)` +
          (isUtility ? ` — utility file exceeds the ${UTILITY_MAX_BYTES} B cap` : ''),
      );
    }
  }

  for (const a of allowed) console.log(`  · allowed: ${a}`);

  if (violations.length > 0) {
    console.error('\n✗ Imported art assets found in the build.');
    console.error('  All content must be generated procedurally (requirement 7.14).\n');
    for (const v of violations) console.error(`    ${v}`);
    process.exit(1);
  }

  console.log(`✓ No imported art assets in ${DIST}/ (${files.length} files checked)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
