const http = require('node:http');
const { loadConfig } = require('./config');
const { logRequest } = require('./middleware/logging');
const { health } = require('./routes/health');

const env = process.env.GATEKEEPER_ENV || 'production';
const config = loadConfig(env);

const server = http.createServer((req, res) => {
  logRequest(config, req);
  if (req.url === '/healthz') return health(req, res);
  res.writeHead(502);
  res.end('no upstream configured\n');
});

server.listen(config.port, config.host, () => {
  console.log(`gatekeeper [${env}] listening on ${config.host}:${config.port}`);
});
