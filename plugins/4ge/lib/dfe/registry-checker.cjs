// lib/dfe/registry-checker.cjs
'use strict';

const REGISTRY_BASE = 'https://registry.npmjs.org';
const DOWNLOADS_BASE = 'https://api.npmjs.org/downloads/point/last-week';
const DELAY_MS = 100;
const RETRY_DELAY_MS = 2000;
const FLAG_THRESHOLDS = {
  new_days: 90,
  low_downloads: 1000,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check a single package against the npm registry.
 * @param {string} pkgName
 * @returns {Promise<Object>}
 */
async function checkPackage(pkgName) {
  if (typeof fetch !== 'function') {
    throw new Error(
      '[registry-checker] fetch is not available. Node.js 18+ is required. ' +
      `Current version: ${process.version}`
    );
  }

  const base = { name: pkgName };

  let registryData;
  let retries = 0;

  while (retries < 2) {
    try {
      const resp = await fetch(`${REGISTRY_BASE}/${encodeURIComponent(pkgName)}`);
      if (!resp.ok) {
        if (resp.status === 404) {
          return { ...base, exists: false, flags: ['not-found'] };
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      registryData = await resp.json();
      break;
    } catch (err) {
      retries++;
      if (retries >= 2) {
        return { ...base, exists: false, flags: ['unchecked'], error: `network_unreachable: ${err.message}` };
      }
      await sleep(RETRY_DELAY_MS);
    }
  }

  const latest = registryData['dist-tags']?.latest;
  const latestVersion = registryData.versions?.[latest] || {};
  const created = new Date(registryData.time?.created || 0);
  const ageDays = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
  const maintainerCount = (registryData.maintainers || []).length;
  const scripts = latestVersion.scripts || {};
  const hasInstallScripts = !!(scripts.preinstall || scripts.install || scripts.postinstall);
  const deprecated = !!latestVersion.deprecated;
  const license = registryData.license || latestVersion.license || 'unknown';

  // Fetch weekly downloads
  let weeklyDownloads = 0;
  try {
    const dlResp = await fetch(`${DOWNLOADS_BASE}/${encodeURIComponent(pkgName)}`);
    if (dlResp.ok) {
      const dlData = await dlResp.json();
      weeklyDownloads = dlData.downloads || 0;
    }
  } catch {
    // Downloads API failure is non-critical
  }

  const flags = [];
  if (ageDays < FLAG_THRESHOLDS.new_days) flags.push('new');
  if (weeklyDownloads < FLAG_THRESHOLDS.low_downloads) flags.push('low-downloads');
  if (maintainerCount === 1) flags.push('single-maintainer');
  if (hasInstallScripts) flags.push('install-scripts');
  if (deprecated) flags.push('deprecated');

  return {
    ...base,
    exists: true,
    age_days: ageDays,
    weekly_downloads: weeklyDownloads,
    maintainer_count: maintainerCount,
    has_install_scripts: hasInstallScripts,
    deprecated,
    latest_version: latest || 'unknown',
    license,
    flags,
  };
}

/**
 * Check multiple packages sequentially with rate limiting.
 * @param {string[]} packages
 * @returns {Promise<Object>}
 */
async function check(packages) {
  const results = [];
  for (let i = 0; i < packages.length; i++) {
    if (i > 0) await sleep(DELAY_MS);
    const result = await checkPackage(packages[i]);
    results.push(result);
  }
  return { packages: results };
}

// CLI entry point
if (require.main === module) {
  const packages = process.argv.slice(2);
  if (packages.length === 0) {
    process.stderr.write('Usage: node registry-checker.cjs <pkg> [<pkg>...]\n');
    process.exit(1);
  }
  check(packages).then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch((err) => {
    process.stderr.write(`[registry-checker] fatal: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { checkPackage, check, FLAG_THRESHOLDS };
