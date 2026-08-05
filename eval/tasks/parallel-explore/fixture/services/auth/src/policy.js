// Base token policy. Client-class modules may cap these values further;
// this file alone does not determine any client's effective lifetime.
const REFRESH_BASE_DAYS = 30;
const ACCESS_TTL_MINUTES = 20;

module.exports = { REFRESH_BASE_DAYS, ACCESS_TTL_MINUTES };
