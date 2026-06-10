// Scanner B canary: eval-injection
// Triggers: eval-direct (CWE-95), dynamic-require (CWE-94)
// Layer 1 and Layer 3 (AST) should both flag this.

function processUserInput(userInput) {
  // CANARY: eval with a variable argument — not a literal string
  const result = eval(userInput);
  return result;
}

function loadModule(moduleName) {
  // CANARY: dynamic require with a variable
  const mod = require(moduleName);
  return mod;
}

module.exports = { processUserInput, loadModule };
