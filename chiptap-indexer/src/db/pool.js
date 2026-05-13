import pg from "pg";
import config from "../config/index.js";

pg.types.setTypeParser(20, (val) => parseInt(val, 10));   // BIGINT
pg.types.setTypeParser(1700, (val) => parseFloat(val));     // NUMERIC

const pool = new pg.Pool({
  connectionString: config.db.url,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("PG pool error:", err);
  process.exit(1);
});

export const query = (text, params) => pool.query(text, params);
export const getClient = () => pool.connect();
export default { query, getClient, pool };
