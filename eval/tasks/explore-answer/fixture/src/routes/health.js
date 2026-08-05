function health(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }) + '\n');
}

module.exports = { health };
