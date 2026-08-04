'use strict';

const bcrypt = require('bcryptjs');
const { normalizeEnvDatabaseUrl } = require('../lib/database-url');

normalizeEnvDatabaseUrl();

const TEST_BCRYPT_ROUNDS = Number(process.env.TEST_BCRYPT_ROUNDS || 4);

if (Number.isInteger(TEST_BCRYPT_ROUNDS) && TEST_BCRYPT_ROUNDS >= 4 && TEST_BCRYPT_ROUNDS < 10) {
  const originalHash = bcrypt.hash.bind(bcrypt);
  bcrypt.hash = (password, saltOrRounds, callback, progressCallback) => {
    const rounds = typeof saltOrRounds === 'number' && saltOrRounds > TEST_BCRYPT_ROUNDS
      ? TEST_BCRYPT_ROUNDS
      : saltOrRounds;
    return originalHash(password, rounds, callback, progressCallback);
  };
}
