module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  plugins: ['@typescript-eslint', 'prettier', 'eslint-plugin-unused-imports'],
  env: { node: true, es2022: true, jest: true },
  rules: {
    'prettier/prettier': 'error',
    'no-console': 'error',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'unused-imports/no-unused-imports': 'error',
  },
  ignorePatterns: ['.eslintrc.js', 'node_modules', 'dist', 'coverage', '.serverless', 'packages/contracts/generated'],
  overrides: [
    {
      files: ['*.spec.ts', 'src/test/**/*.ts'],
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
    {
      files: ['*.js'],
      rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
  ],
};
