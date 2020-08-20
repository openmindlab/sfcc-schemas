#!/usr/bin/env node
const sfccSchemas = require('./sfcc-schemas');

(() => {
  sfccSchemas.validate(true);
})();

export { };