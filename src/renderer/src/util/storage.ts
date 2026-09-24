/* ============================================================
 * Web Storage 安全访问小工具（try/catch 统一收口）
 * 动机：localStorage/sessionStorage 在「存储被禁 / 隐私模式配额为 0 /
 * 配额满」时读写即抛——裸调用发生在 bootstrap 早期（主题/欢迎页/侧栏
 * 状态读取）会直接炸掉整窗初始化。所有镜像/偏好读写统一走这里，
 * 失败降级为"无存储"语义（get 恒 null、set 静默丢弃），不阻断功能。
 * ============================================================ */

export interface SafeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

function createSafeStorage(kind: 'local' | 'session'): SafeStorage {
  /** 访问 window.localStorage 本身也可能抛（SecurityError：存储被策略禁用） */
  const pick = (): Storage | null => {
    try {
      return kind === 'local' ? window.localStorage : window.sessionStorage;
    } catch {
      return null;
    }
  };
  return {
    get(key) {
      try {
        return pick()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        pick()?.setItem(key, value);
      } catch {
        // 配额满 / 存储禁用：镜像丢失可接受（settings.json 权威侧另有持久化）
      }
    },
    remove(key) {
      try {
        pick()?.removeItem(key);
      } catch {
        // 同上，静默
      }
    }
  };
}

export const localStore: SafeStorage = createSafeStorage('local');
export const sessionStore: SafeStorage = createSafeStorage('session');
