'use strict';

/**
 * egress.cjs — AISLE Scanner E
 *
 * Data exfiltration and egress monitoring. Three detection vectors:
 *   1. DNS exfiltration patterns (long labels, high entropy, encoding)
 *   2. Credential patterns in commands (18 merged from secret-guard + token-guard)
 *   3. IOC domain matching (burp, ngrok, interact.sh, supply-chain C2)
 *
 * Per-tool evaluate() intercepts Bash and MCP tool calls.
 * Boot-time scan() inspects hooks/scripts for outbound network patterns.
 * Synchronous throughout (P0-B compliance).
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCANNER_ID = 'E';
const CANARY_DIR = path.resolve(__dirname, '../canaries/E');
const DATA_DIR = path.resolve(__dirname, '../data');

const RULE_OF_TWO = { untrusted: false, sensitive: false, external: true };

// Egress allowlist — destinations that are always permitted
const EGRESS_ALLOWLIST = new Set([
  'registry.npmjs.org',
  'api.github.com',
  'github.com',
  'api.osv.dev',
  'pypi.org',
  'rubygems.org',
  'crates.io',
  'api.nuget.org',
  'hub.docker.com',
  'registry.docker.io',
]);

// P1-5: URL_PATTERNS removed — were defined but never referenced.
// extractHostnames() uses its own inline regex.

// P1-1: URL/credential checks no longer gated by this (moved outside guard)

// ---------------------------------------------------------------------------
// Load data files
// ---------------------------------------------------------------------------

let iocDomains = [];
let secretPatterns = [];

function loadDataFiles() {
  // P2-1: Emit stderr warning when data files are missing — silent degradation
  // means zero protection without any observable signal.
  try {
    const iocData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'egress-iocs.json'), 'utf8'));
    iocDomains = (iocData.domains || []).map(d => typeof d === 'string' ? d : d.domain);
  } catch (err) {
    process.stderr.write(`[AISLE:egress] WARNING: egress-iocs.json unavailable (${err.code || err.message}) — IOC domain protection disabled\n`);
  }

  try {
    const secretData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'secret-patterns.json'), 'utf8'));
    // P1-9: ReDoS guard — reject malformed or overly complex external patterns
    secretPatterns = (secretData.patterns || [])
      .filter(p => p.regex && typeof p.regex === 'string' && p.regex.length <= 200)
      .map(p => {
        try { return { regex: new RegExp(p.regex), label: p.label, id: p.id }; }
        catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    process.stderr.write(`[AISLE:egress] WARNING: secret-patterns.json unavailable (${err.code || err.message}) — credential detection in egress disabled\n`);
  }
}

// Load on module init
loadDataFiles();

// ---------------------------------------------------------------------------
// DNS Exfiltration Detection
// ---------------------------------------------------------------------------

/**
 * Calculate Shannon entropy of a string.
 * @param {string} str
 * @returns {number}
 */
function shannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const freq = {};
  for (const ch of str) {
    freq[ch] = (freq[ch] || 0) + 1;
  }
  let entropy = 0;
  const len = str.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Detect DNS exfiltration patterns in a hostname.
 * @param {string} hostname
 * @returns {{ detected: boolean, reason?: string }}
 */
function detectDNSExfil(hostname) {
  if (!hostname) return { detected: false };
  const labels = hostname.split('.');

  for (const label of labels) {
    if (label.length > 63) {
      return { detected: true, reason: 'label > 63 chars' };
    }
    // Hex-encoded label (most specific — subset of base64 charset)
    if (/^[0-9a-fA-F]+$/.test(label) && label.length > 16) {
      return { detected: true, reason: 'hex-encoded subdomain' };
    }
    // Base32-encoded label (DNS tunneling tools: dnscat2, iodine)
    if (/^[A-Z2-7=]+$/i.test(label) && label.length > 16) {
      return { detected: true, reason: 'base32-encoded subdomain' };
    }
    // Standard + URL-safe base64 (general encoding pattern)
    if (/^[A-Za-z0-9+/=_-]+$/.test(label) && label.length > 20) {
      return { detected: true, reason: 'base64-encoded subdomain' };
    }
    // High entropy catch-all
    if (label.length > 8 && shannonEntropy(label) > 4.0) {
      return { detected: true, reason: 'high entropy label' };
    }
  }

  // Adversarial split-label variant
  const joined = labels.slice(0, -2).join('');
  if (joined.length > 40 && shannonEntropy(joined) > 4.5) {
    return { detected: true, reason: 'split-label encoding' };
  }

  return { detected: false };
}

/**
 * Extract hostnames from URLs in text.
 * @param {string} text
 * @returns {string[]}
 */
function extractHostnames(text) {
  const hostnames = new Set();
  const urlRegex = /https?:\/\/([^/\s:?"']+)/g;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    let hostname = match[1].toLowerCase();
    // P1-2: URL-decode to prevent IOC evasion via percent-encoding
    try { hostname = decodeURIComponent(hostname); } catch { /* keep original */ }
    hostnames.add(hostname);
  }
  // DNS tool targets (dig, nslookup, host)
  const dnsRegex = /\b(?:dig|nslookup|host)\s+(?:\S+\s+)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  while ((match = dnsRegex.exec(text)) !== null) {
    hostnames.add(match[1].toLowerCase());
  }
  return Array.from(hostnames);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeFinding(opts) {
  return {
    scannerId: SCANNER_ID,
    severity: opts.severity || 'HIGH',
    title: opts.title,
    description: opts.description,
    filePath: opts.filePath || null,
    ruleOfTwo: { ...RULE_OF_TWO, sensitive: opts.sensitive || false },
    actions: opts.actions || [],
    tier: opts.tier || 'BLOCK',
    flags: { ...RULE_OF_TWO, sensitive: opts.sensitive || false },
    scanner: SCANNER_ID,
    pattern: opts.pattern || opts.title,
  };
}

/**
 * Check if a hostname matches any IOC domain.
 * @param {string} hostname
 * @returns {object|null} Matching IOC entry or null
 */
function matchIOC(hostname) {
  for (const ioc of iocDomains) {
    if (hostname === ioc || hostname.endsWith('.' + ioc)) {
      return { domain: ioc };
    }
  }
  return null;
}

/**
 * Check text for credential patterns.
 * @param {string} text
 * @returns {object[]} Matched patterns
 */
function detectCredentials(text) {
  const matches = [];
  for (const { regex, label, id } of secretPatterns) {
    if (regex.test(text)) {
      matches.push({ id, label });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Scanner contract
// ---------------------------------------------------------------------------

module.exports = {
  id: SCANNER_ID,
  name: 'egress',
  version: '1.0.0',
  defaultTier: 'BLOCK',
  cadence: ['per-tool'],
  capabilities: { network: true, fs: true, env: [] },

  /**
   * Per-tool evaluation for egress monitoring.
   */
  evaluate(toolInput, _cachedState) {
    const findings = [];
    const toolName = toolInput.tool_name || '';
    const input = toolInput.tool_input || {};

    // --- Bash tool checks ---
    // P1-1: URL/credential checks no longer gated by NETWORK_COMMANDS.
    // python3 -c/node -e with URLs would bypass the old guard.
    const command = input.command || '';
    if (toolName === 'Bash' && command) {
      const hostnames = extractHostnames(command);

      for (const hostname of hostnames) {
        // Skip allowlisted destinations
        if (EGRESS_ALLOWLIST.has(hostname)) continue;

        // IOC check
        const iocMatch = matchIOC(hostname);
        if (iocMatch) {
          findings.push(makeFinding({
            severity: 'CRITICAL',
            title: 'Egress to IOC domain',
            description: `Command contacts known-malicious domain: ${iocMatch.domain}`,
            pattern: `ioc:${iocMatch.domain}`,
          }));
        }

        // DNS exfiltration check
        const dnsResult = detectDNSExfil(hostname);
        if (dnsResult.detected) {
          findings.push(makeFinding({
            severity: 'HIGH',
            title: 'DNS exfiltration pattern detected',
            description: `Hostname "${hostname}" flagged: ${dnsResult.reason}`,
            pattern: `dns-exfil:${dnsResult.reason}`,
          }));
        }

        // Non-allowlisted external destination
        if (!iocMatch && !dnsResult.detected) {
          findings.push(makeFinding({
            severity: 'MEDIUM',
            title: 'Egress to non-allowlisted destination',
            description: `Command contacts external host: ${hostname}`,
            tier: 'WARN',
            pattern: `non-allowlisted:${hostname}`,
          }));
        }
      }

      // Credential patterns in command
      const creds = detectCredentials(command);
      if (creds.length > 0) {
        findings.push(makeFinding({
          severity: 'CRITICAL',
          title: 'Credential in outbound command',
          description: `Detected: ${creds.map(c => c.label).join(', ')}`,
          sensitive: true,
          pattern: `cred:${creds.map(c => c.id).join(',')}`,
        }));
      }
    }

    // --- MCP tool checks ---
    if (toolName.startsWith('mcp__') && !toolName.startsWith('mcp__dev-memory__')) {
      const inputStr = JSON.stringify(input);

      // Check for external URLs in MCP args
      const mcpHostnames = extractHostnames(inputStr);
      for (const hostname of mcpHostnames) {
        if (!EGRESS_ALLOWLIST.has(hostname)) {
          const iocMatch = matchIOC(hostname);
          findings.push(makeFinding({
            severity: iocMatch ? 'CRITICAL' : 'MEDIUM',
            title: iocMatch ? 'MCP tool contacts IOC domain' : 'MCP tool sends data externally',
            description: `MCP tool "${toolName}" targets: ${hostname}`,
            tier: iocMatch ? 'BLOCK' : 'WARN',
            pattern: iocMatch ? `mcp-ioc:${hostname}` : `mcp-egress:${hostname}`,
          }));
        }
      }

      // Check for credentials in MCP args
      const mcpCreds = detectCredentials(inputStr);
      if (mcpCreds.length > 0) {
        findings.push(makeFinding({
          severity: 'CRITICAL',
          title: 'Credential in MCP tool arguments',
          description: `MCP tool "${toolName}" contains: ${mcpCreds.map(c => c.label).join(', ')}`,
          sensitive: true,
          pattern: `mcp-cred:${mcpCreds.map(c => c.id).join(',')}`,
        }));
      }
    }

    const hasBlock = findings.some(f => f.tier === 'BLOCK');
    return { allow: !hasBlock, findings };
  },

  /**
   * Boot-time scan for outbound network patterns in project files.
   */
  scan(context) {
    const findings = [];
    const cwd = context.cwd || process.cwd();
    const startTime = Date.now();

    // Scan hooks and scripts for outbound network patterns
    const scanDirs = [
      path.join(cwd, '.claude/hooks'),
      path.join(cwd, 'scripts'),
    ];

    for (const dir of scanDirs) {
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }

      for (const file of files) {
        if (!file.endsWith('.cjs') && !file.endsWith('.js') && !file.endsWith('.sh')) continue;
        try {
          const content = fs.readFileSync(path.join(dir, file), 'utf8');
          const hostnames = extractHostnames(content);
          for (const hostname of hostnames) {
            const iocMatch = matchIOC(hostname);
            if (iocMatch) {
              findings.push(makeFinding({
                severity: 'CRITICAL',
                title: 'IOC domain in project file',
                description: `${file} references IOC domain: ${iocMatch.domain}`,
                filePath: path.join(dir, file),
                pattern: `scan-ioc:${iocMatch.domain}`,
              }));
            }
          }
        } catch { /* skip unreadable files */ }
      }
    }

    return { findings, duration: Date.now() - startTime, cachedState: {} };
  },

  /**
   * Self-test against canary fixtures.
   */
  selfTest() {
    const results = [];

    // dns-exfil.sh canary
    try {
      const content = fs.readFileSync(path.join(CANARY_DIR, 'dns-exfil.sh'), 'utf8');
      const hostnames = extractHostnames(content);
      const detected = hostnames.some(h => {
        const dns = detectDNSExfil(h);
        const ioc = matchIOC(h);
        return dns.detected || ioc;
      });
      results.push({ canary: 'dns-exfil.sh', detected });
    } catch (err) {
      results.push({ canary: 'dns-exfil.sh', detected: false, error: err.message });
    }

    // curl-secrets.sh canary
    try {
      const content = fs.readFileSync(path.join(CANARY_DIR, 'curl-secrets.sh'), 'utf8');
      const creds = detectCredentials(content);
      results.push({ canary: 'curl-secrets.sh', detected: creds.length > 0, count: creds.length });
    } catch (err) {
      results.push({ canary: 'curl-secrets.sh', detected: false, error: err.message });
    }

    // mcp-egress.json canary
    try {
      const canary = JSON.parse(fs.readFileSync(path.join(CANARY_DIR, 'mcp-egress.json'), 'utf8'));
      const result = module.exports.evaluate(canary, {});
      results.push({ canary: 'mcp-egress.json', detected: result.findings.length > 0 });
    } catch (err) {
      results.push({ canary: 'mcp-egress.json', detected: false, error: err.message });
    }

    return { pass: results.every(r => r.detected), details: results };
  },

  /**
   * Health check.
   */
  health() {
    return {
      status: iocDomains.length > 0 && secretPatterns.length > 0 ? 'healthy' : 'degraded',
      iocCount: iocDomains.length,
      patternCount: secretPatterns.length,
    };
  },

  // Exposed for testing
  _internals: {
    shannonEntropy,
    detectDNSExfil,
    extractHostnames,
    detectCredentials,
    matchIOC,
    makeFinding,
    loadDataFiles,
    EGRESS_ALLOWLIST,
    get iocDomains() { return iocDomains; },
    get secretPatterns() { return secretPatterns; },
  },
};
