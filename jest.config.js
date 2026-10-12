module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  setupFiles: ['<rootDir>/.jest/setEnvVars.ts'],
  moduleNameMapper: {
    '^@lib/(.*)$': '<rootDir>/src/lib/$1',
    '^@talvio/llm-contracts/fixtures$': '<rootDir>/packages/contracts/src/fixtures',
    '^@talvio/llm-contracts$': '<rootDir>/packages/contracts/src',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/test/**'],
  coverageThreshold: {
    global: { statements: 80 },
  },
};
