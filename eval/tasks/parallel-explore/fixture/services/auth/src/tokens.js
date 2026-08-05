// Token issuance. Refresh lifetime starts from the base policy and is
// then constrained per client class — client modules get the final say
// via their cap (security review 2026-01).
const { REFRESH_BASE_DAYS } = require("./policy");
const mobile = require("../clients/mobile");
const web = require("../clients/web");

function refreshTokenDays(clientClass) {
  if (clientClass === "mobile") return Math.min(REFRESH_BASE_DAYS, mobile.REFRESH_CAP_DAYS);
  if (clientClass === "web-extended") return web.EXTENDED_REFRESH_DAYS;
  return REFRESH_BASE_DAYS;
}

module.exports = { refreshTokenDays };
