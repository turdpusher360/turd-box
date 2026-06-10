// Scanner B canary: obfuscated-payload
// Triggers: base64-blob (CWE-506)
// Layer 1 regex and Layer 2 entropy should both flag this.

// CANARY: Large Base64-encoded blob — potential obfuscated payload
const payload = Buffer.from('cGF5bG9hZERhdGFIZXJlVGhpc0lzQUxvbmdCYXNlNjRTdHJpbmc=', 'base64');

// CANARY: High-entropy string literal (should trigger Layer 2 entropy analysis)
const encodedConfig = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9tYWxpY2lvdXMtcGF5bG9hZA==';

module.exports = { payload, encodedConfig };
