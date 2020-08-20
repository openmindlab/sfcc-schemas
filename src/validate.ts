#!/usr/bin/env node
import sfccSchemas from './sfcc-schemas';

(() => {
  sfccSchemas.validate(true);
})();

export { };