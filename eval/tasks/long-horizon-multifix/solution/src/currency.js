// cents -> "$12.34"
function formatCents(c) {
  const dollars = Math.floor(c / 100);
  const rem = String(c % 100).padStart(2, "0");
  return "$" + dollars + "." + rem;
}

module.exports = { formatCents };
