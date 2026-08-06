/**
 * 回归脚本使用固定的进程内 token，避免每个脚本重复实现 API headers。
 * 生产进程仍然使用 server.ts 的随机启动 token；该模块只被本地回归脚本显式导入。
 */
export function installRegressionAuth(token = 'aurevoy-regression-token') {
  process.env.AUREVOY_API_TOKEN = token;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return nativeFetch(input, { ...init, headers });
  };
}
