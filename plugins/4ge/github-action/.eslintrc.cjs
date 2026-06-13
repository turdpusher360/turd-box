// GitHub Action is a standalone ESM package — override root CJS config
module.exports = {
  parserOptions: {
    sourceType: 'module',
    ecmaVersion: 2022,
  },
};
