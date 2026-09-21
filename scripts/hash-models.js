'use strict';
/**
 * Prints paste-ready SHA-256 entries for every installed model, so the hashes in
 * MODEL_CATALOG never have to be assembled by hand.
 *
 *   node scripts/hash-models.js            # every model that is installed
 *   node scripts/hash-models.js parakeet   # just one, by key or alias
 *
 * Run it after a revision bump: delete the model from `models/`, let the app
 * download it again, then paste what this prints over the old entries. The
 * bytes are printed from what is actually on disk, so a size that drifted shows
 * up here as a mismatch against the catalogue rather than as a failed install
 * for everyone else.
 *
 * HuggingFace models print their `[remote, as, bytes, sha256]` tuples. Vosk
 * models are a single zip that installZip() deletes after unpacking, so there is
 * nothing left here to hash; point this at a downloaded archive instead:
 *
 *   node scripts/hash-models.js path/to/vosk-model-en-us-0.22.zip
 *
 * which prints the `bytes` and `sha256` for that entry. Two of the four Vosk
 * models carry upstream's published md5 rather than a sha256 we computed, and
 * replacing one of those with a real sha256 is exactly what that form is for.
 */

const fs = require('fs');
const path = require('path');
const {
  MODEL_CATALOG,
  findModel,
  findModelByDir,
  sha256File,
  isInstalled,
} = require('../src/shared/models');
const { modelsDir } = require('../src/shared/paths');

/** `hash-models.js some-model.zip` — print the entry for a downloaded archive. */
async function hashArchive(zipPath) {
  const size = fs.statSync(zipPath).size;
  const sha = await sha256File(zipPath);
  const model = findModelByDir(path.basename(zipPath, '.zip'));

  console.log(`${path.basename(zipPath)}\n`);
  console.log(`    bytes: ${size},`);
  console.log(`    sha256: '${sha}',`);

  if (!model) {
    console.log('\n  No catalogue entry matches that filename — check the name.');
    return;
  }
  if (model.bytes && model.bytes !== size) {
    console.log(`\n  Size differs from the catalogue (${model.bytes}). Wrong file, or`);
    console.log('  upstream changed it — do not paste this without finding out which.');
    return;
  }
  if (model.md5) {
    console.log(
      `\n  ${model.key} currently carries upstream's md5. Replace that line with`
    );
    console.log('  the sha256 above — it is the stronger check and this one is ours.');
  }
}

async function main() {
  const [, , key] = process.argv;
  const root = modelsDir();

  if (key && key.toLowerCase().endsWith('.zip')) {
    if (!fs.existsSync(key)) {
      console.error(`No such file: ${key}`);
      process.exitCode = 1;
      return;
    }
    await hashArchive(key);
    return;
  }

  let models = MODEL_CATALOG;
  if (key) {
    const one = findModel(key);
    if (!one) {
      console.error(`Unknown model "${key}".`);
      process.exitCode = 1;
      return;
    }
    models = [one];
  }

  console.log(`models dir: ${root}\n`);
  let printed = 0;

  for (const model of models) {
    const target = path.join(root, model.dir);

    if (!isInstalled(target, model)) {
      if (key) console.log(`${model.key} is not installed — download it first.`);
      continue;
    }

    console.log(`--- ${model.key} (${model.dir})`);

    if (!model.files) {
      // Vosk: the download is one archive, and installZip() removes it.
      const has = model.sha256
        ? 'sha256 (ours)'
        : model.md5
          ? "md5 (upstream's)"
          : 'nothing';
      console.log(`    verified by: ${has}`);
      if (!model.sha256) {
        console.log(
          '    The archive is gone, so there is nothing here to hash. For a real'
        );
        console.log('    sha256, download it and pass the path to this script:');
        console.log(`      ${model.url}`);
      }
      console.log('');
      continue;
    }

    for (const file of model.files) {
      const filePath = path.join(target, file.as);
      if (!fs.existsSync(filePath)) {
        console.log(`    MISSING ${file.as}`);
        continue;
      }

      const size = fs.statSync(filePath).size;
      const hash = await sha256File(filePath);
      // file.url is the pinned resolve URL; everything past the revision is the
      // remote path as it appears in the catalogue.
      const remote = file.url.split('/').slice(7).join('/');

      console.log(`      ['${remote}', '${file.as}', ${size}, '${hash}'],`);
      if (size !== file.bytes) {
        console.log(`      ^^ size differs: on disk ${size}, catalogue ${file.bytes}`);
      }
      printed++;
    }

    console.log('');
  }

  if (!printed && !key) {
    console.log('No per-file models installed. Download one, then run this again.');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
