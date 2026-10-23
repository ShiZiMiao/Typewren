/* ============================================================
 * 站点脚本问题数据安全解析（纯函数，无 Milkdown/DOM 依赖）
 * 供 quiz.ts 使用；独立成模块以便单测直接 import
 * （quiz.ts 顶层拖入 @milkdown/kit，Playwright 的 Node 侧
 * 单测无法加载）。仅处理纯数据字面量，**无 eval、无
 * new Function**；任何函数/表达式形式都解析失败并回退。
 * ============================================================ */

/** 站点脚本常见的问题数据变量名（按序尝试，不写死 quizData） */
const QUIZ_DATA_NAMES = ['quizData', 'questions', 'quizQuestions', 'data'];

/** 从 script 块文本提取 `const <name> = [...]` 的平衡区间（多变量名通用）。
 * 变量名后允许可选 TS 类型标注（`const quizData: QuizItem[] = […]`——
 * VitePress `<script setup lang="ts">` 的常见形态）：标注段不含 `=`
 * （含 `=>` 的函数类型会失配走回退，属可接受边界） */
function extractQuizDataText(scriptValue: string): string | null {
  for (const name of QUIZ_DATA_NAMES) {
    const header = scriptValue.match(new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]*?)?\\s*=`));
    if (!header || header.index === undefined) continue;
    let i = header.index + header[0].length;
    const text = scriptValue;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '[') continue;

    let depth = 0;
    let inStr: string | null = null;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === inStr) inStr = null;
        continue;
      }
      // 注释跳过（// 行注释、/* 块注释）——括号计数不受注释内容干扰
      if (ch === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
        continue;
      }
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return text.slice(header.index + header[0].length, i + 1);
      }
    }
  }
  return null;
}

function parseJsLiteral(src: string): unknown {
  let i = 0;
  /** 跳过空白与注释（// 行注释、/* 块注释） */
  const skipTrivia = (): void => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (src[i] === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2; // 跳过 */
        continue;
      }
      break;
    }
  };
  const readIdent = (): string => {
    const start = i;
    while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++;
    return src.slice(start, i);
  };
  const parseValue = (): unknown => {
    skipTrivia();
    const ch = src[i];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"' || ch === "'" || ch === '`') return parseString();
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = i;
      while (i < src.length && /[-+.0-9eE]/.test(src[i])) i++;
      return Number(src.slice(start, i));
    }
    const word = readIdent();
    if (word === '') throw new Error('unexpected token');
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    // 裸词：作为字符串保留（如变量引用会被当文本，不解析）
    return word;
  };
  const parseString = (): string => {
    const quote = src[i];
    i++;
    let out = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\' && i + 1 < src.length) {
        const next = src[i + 1];
        // 支持 \uXXXX 与 \xNN（如 "\u4e2d"、"abc\x41"），否则解析成字面 "u4e2d"
        if (next === 'u' && i + 6 <= src.length) {
          const hex = src.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
        }
        if (next === 'x' && i + 4 <= src.length) {
          const hex = src.slice(i + 2, i + 4);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            continue;
          }
        }
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
        i += 2;
        continue;
      }
      if (ch === quote) {
        i++;
        return out;
      }
      out += ch;
      i++;
    }
    throw new Error('unterminated string');
  };
  const parseObject = (): Record<string, unknown> => {
    i++; // {
    const obj: Record<string, unknown> = {};
    skipTrivia();
    while (i < src.length && src[i] !== '}') {
      skipTrivia();
      const ch = src[i];
      const key = ch === '"' || ch === "'" || ch === '`' ? parseString() : readIdent();
      skipTrivia();
      if (src[i] === ':') i++;
      const value = parseValue();
      // __proto__ 赋值会走原型 setter——解析产物只当纯数据用，跳过该键防原型污染
      if (key !== '__proto__') obj[key] = value;
      skipTrivia();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === '}') break;
      throw new Error('object key expected');
    }
    i++; // }
    return obj;
  };
  const parseArray = (): unknown[] => {
    i++; // [
    const arr: unknown[] = [];
    skipTrivia();
    while (i < src.length && src[i] !== ']') {
      arr.push(parseValue());
      skipTrivia();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === ']') break;
      throw new Error('array item expected');
    }
    i++; // ]
    return arr;
  };
  return parseValue();
}

/** 提取并解析问题数据（失败返回 null——调用方回退原样文本） */
export function parseQuizData(scriptValue: string): Record<string, unknown>[] | null {
  const text = extractQuizDataText(scriptValue);
  if (!text) return null;
  try {
    const parsed = parseJsLiteral(text);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
  } catch {
    return null;
  }
}
