/* ============================================================
 * mdast 树操作的宽松节点类型（details/quiz 两个 transform 共用）
 * Milkdown 的 mdast 树在 transform 阶段带自定义节点
 * （detailsHtml/interactiveQuiz），类型系统无法表达，各模块
 * 以本接口做宽松往返（树结构增删时不抛类型错）。
 * ============================================================ */

export interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: unknown;
  summary?: string;
  open?: boolean;
}
