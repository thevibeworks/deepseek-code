const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function isEmail(s) {
  return EMAIL_RE.test(s);
}

module.exports = { isEmail };
