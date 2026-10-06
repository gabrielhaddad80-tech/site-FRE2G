'use strict';
module.exports = {
  join: (...p) => p.join('/').replace(/\/+/g, '/'),
  dirname: (p) => p.split('/').slice(0, -1).join('/') || '/'
};
