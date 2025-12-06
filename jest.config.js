module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/prompt-lab'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // Test groups for targeted running
  projects: [
    {
      displayName: 'prompts',
      testMatch: ['<rootDir>/tests/prompts/**/*.test.ts'],
      preset: 'ts-jest',
      testEnvironment: 'node',
    },
    {
      displayName: 'webhook',
      testMatch: ['<rootDir>/tests/webhook.test.ts'],
      preset: 'ts-jest',
      testEnvironment: 'node',
    },
  ],
};
