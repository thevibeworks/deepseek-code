// HTTP handlers for documents. Thin: parse, delegate, serialize.
// Business rules live in the domain modules, never here — a handler that
// makes decisions is a handler that gets bypassed by the next caller.
const { toWire, toWireCollection, fromWire } = require("../lib/serializer");
const { paginate } = require("../lib/pagination");
const { validateDocument } = require("../lib/validators");
const { statusFor, invalid } = require("../lib/errors");

function makeHandlers(repo) {
  return {
    async get(req, res) {
      try {
        res.json(toWire(repo.get(req.params.id)));
      } catch (err) {
        res.status(statusFor(err)).json({ error: err.code, message: err.message });
      }
    },

    async list(req, res) {
      const page = paginate(repo.list(), {
        cursor: req.query.cursor,
        pageSize: req.query.page_size ? Number(req.query.page_size) : undefined,
      });
      res.json({ ...toWireCollection(page.items), next_cursor: page.nextCursor });
    },

    async put(req, res) {
      const document = fromWire(req.body ?? {});
      const problems = validateDocument(document);
      if (problems.length > 0) {
        const err = invalid(problems);
        return res.status(statusFor(err)).json({ error: err.code, details: err.details });
      }
      res.json(toWire(repo.put(document)));
    },

    async remove(req, res) {
      try {
        repo.remove(req.params.id);
        res.status(204).end();
      } catch (err) {
        res.status(statusFor(err)).json({ error: err.code, message: err.message });
      }
    },
  };
}

function mount(app, basePath, repo) {
  const h = makeHandlers(repo);
  app.get(`${basePath}/:id`, h.get);
  app.get(basePath, h.list);
  app.put(`${basePath}/:id`, h.put);
  app.delete(`${basePath}/:id`, h.remove);
  return app;
}

module.exports = { makeHandlers, mount };
