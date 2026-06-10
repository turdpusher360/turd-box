// Scanner B canary: adversarial-eval
// Triggers: eval-indirect, eval-globalthis, eval-reflect (all CWE-95)
// These are obfuscated eval variants designed to evade naive detection.

function indirectEval(code) {
  // CANARY: (0, eval) — indirect eval bypasses strict mode lexical scope
  return (0, eval)(code);
}

function globalThisEval(code) {
  // CANARY: globalThis.eval — avoids direct identifier reference
  return globalThis.eval(code);
}

function reflectEval(code) {
  // CANARY: Reflect.apply(eval, ...) — reflective dispatch
  return Reflect.apply(eval, null, [code]);
}

function bracketEval(code) {
  // CANARY: bracket notation ['eval']() — obfuscated property access
  return global['eval'](code);
}

module.exports = { indirectEval, globalThisEval, reflectEval, bracketEval };
