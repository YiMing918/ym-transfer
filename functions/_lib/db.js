// db.js — D1 访问封装
// 铁律：只许参数化查询（prepare + bind），禁止把用户输入拼进 SQL 字符串——防注入全靠这一条。

export async function run(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}
export async function first(env, sql, ...params) {
  const row = await env.DB.prepare(sql).bind(...params).first();
  return row ?? null;
}
export async function all(env, sql, ...params) {
  const r = await env.DB.prepare(sql).bind(...params).all();
  return r.results || [];
}
// 批量执行（多语句场景）；D1 每批上限 100 条，调用方自行分批
export async function batch(env, statements) {
  const prepared = statements.map(([sql, params]) => env.DB.prepare(sql).bind(...(params || [])));
  return env.DB.batch(prepared);
}
