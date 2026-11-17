'use strict';

if (process.env.BOB_TEST_POSTGRES === '1') require('./place-service-terms-migration.test');
