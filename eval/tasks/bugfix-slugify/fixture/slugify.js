// Turn arbitrary text into a URL-safe slug.
function slugify(input) {
  return String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '-');
}

module.exports = slugify;
