/**
 * 页签级会话标识：
 * 存于 sessionStorage，同一页签刷新后保持不变，关闭页签即丢失，
 * 正好用于区分「两个页签抢同一台仪器」。
 */
const SESSION_KEY = 'gbclockrepair:session-id';

let fallbackId: string | undefined;

export function sessionId(): string {
  try {
    let id = window.sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      const stamp = Date.now().toString(36);
      const rand = Math.random().toString(36).slice(2, 10);
      id = `sess_${stamp}${rand}`;
      window.sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // sessionStorage 不可用时退化为本次运行的内存标识
    if (!fallbackId) {
      fallbackId = `sess_mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }
    return fallbackId;
  }
}
