// Routeur minimal compatible avec l'usage d'express.Router() dans src/routes
'use strict';
function Router() {
  const routes = [];
  const r = { routes };
  for (const m of ['get', 'post', 'put', 'delete']) {
    r[m] = (path, ...handlers) => {
      const keys = [];
      const re = new RegExp('^' + path.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
      routes.push({ method: m.toUpperCase(), re, keys, handler: handlers[handlers.length - 1] });
    };
  }
  return r;
}
module.exports = { Router };
