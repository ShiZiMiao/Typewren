/* ============================================================
 * 搜索栏组件：Ctrl+F 查找 / Esc 关闭 / Enter 下一个 / Shift+Enter 上一个
 * 替换功能：Ctrl+H 切换替换面板
 * 渲染模式和源码模式统一使用 CSS Custom Highlight API
 * ============================================================ */

import type { Editor } from '@milkdown/kit/core'
import { editorViewCtx } from '@milkdown/kit/core'

export interface SearchBar {
  container: HTMLElement
  show(): void
  hide(): void
  toggle(): void
  toggleReplace(): void
}

export function createSearchBar(
  parent: HTMLElement,
  getSourceMode: () => boolean,
  getSourceElement: () => HTMLElement | null,
  editor: Editor
): SearchBar {
  const container = document.createElement('div')
  container.id = 'search-bar'
  container.style.display = 'none'

  const input = document.createElement('input')
  input.type = 'text'
  input.id = 'search-input'
  input.placeholder = '查找…'
  input.spellcheck = false

  const matchCount = document.createElement('span')
  matchCount.id = 'search-match-count'
  matchCount.textContent = '0/0'

  const btnPrev = document.createElement('button')
  btnPrev.type = 'button'
  btnPrev.id = 'search-prev'
  btnPrev.title = '上一个 (Shift+Enter)'
  btnPrev.textContent = '‹'

  const btnNext = document.createElement('button')
  btnNext.type = 'button'
  btnNext.id = 'search-next'
  btnNext.title = '下一个 (Enter)'
  btnNext.textContent = '›'

  const btnToggleReplace = document.createElement('button')
  btnToggleReplace.type = 'button'
  btnToggleReplace.id = 'search-toggle-replace'
  btnToggleReplace.title = '切换替换 (Ctrl+H)'
  btnToggleReplace.textContent = '⇄'

  const btnClose = document.createElement('button')
  btnClose.type = 'button'
  btnClose.id = 'search-close'
  btnClose.title = '关闭 (Esc)'
  btnClose.textContent = '✕'

  container.append(input, matchCount, btnPrev, btnNext, btnToggleReplace, btnClose)

  // ---------- 替换行 ----------
  const replaceRow = document.createElement('div')
  replaceRow.id = 'replace-row'
  replaceRow.style.display = 'none'

  const replaceInput = document.createElement('input')
  replaceInput.type = 'text'
  replaceInput.id = 'replace-input'
  replaceInput.placeholder = '替换…'
  replaceInput.spellcheck = false

  const btnReplace = document.createElement('button')
  btnReplace.type = 'button'
  btnReplace.id = 'btn-replace'
  btnReplace.title = '替换当前'
  btnReplace.textContent = '替换'

  const btnReplaceAll = document.createElement('button')
  btnReplaceAll.type = 'button'
  btnReplaceAll.id = 'btn-replace-all'
  btnReplaceAll.title = '全部替换'
  btnReplaceAll.textContent = '全部'

  replaceRow.append(replaceInput, btnReplace, btnReplaceAll)
  container.append(replaceRow)

  parent.appendChild(container)

  let matchIndex = 0
  let totalMatches = 0
  let lastKeyword = ''
  let replaceVisible = false

  // CSS Custom Highlight API
  const searchHighlight = new Highlight()
  const searchHighlightCurrent = new Highlight()
  CSS.highlights.set('search-highlight', searchHighlight)
  CSS.highlights.set('search-highlight-current', searchHighlightCurrent)

  const style = document.createElement('style')
  style.textContent = `
    ::highlight(search-highlight) {
      background-color: #fff3a8;
    }
    ::highlight(search-highlight-current) {
      background-color: #ff9632;
      outline: 2px solid #e07000;
    }
    [data-theme='dark'] ::highlight(search-highlight) {
      background-color: #5a4a00;
    }
    [data-theme='dark'] ::highlight(search-highlight-current) {
      background-color: #b8860b;
      outline-color: #daa520;
    }
  `
  document.head.appendChild(style)

  function getEditorDom(): HTMLElement | null {
    return document.querySelector('.ProseMirror')
  }

  function clearHighlights(): void {
    searchHighlight.clear()
    searchHighlightCurrent.clear()
  }

  // ---------- 统一搜索逻辑（渲染模式 + 源码模式） ----------
  function highlightAll(keyword: string): void {
    clearHighlights()
    totalMatches = 0
    matchIndex = 0
    currentRanges = []

    if (!keyword) {
      matchCount.textContent = '0/0'
      return
    }

    // 根据模式选择搜索目标
    const targetEl = getSourceMode() ? getSourceElement() : getEditorDom()
    if (!targetEl) return

    lastKeyword = keyword
    const lowerKeyword = keyword.toLowerCase()

    // 收集所有文本节点
    const walker = document.createTreeWalker(targetEl, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode as Text)
    }

    // 查找所有匹配并创建 Range
    const ranges: Range[] = []

    textNodes.forEach((node) => {
      const text = node.textContent || ''
      const lowerText = text.toLowerCase()

      let pos = 0
      while (pos < lowerText.length) {
        const idx = lowerText.indexOf(lowerKeyword, pos)
        if (idx === -1) break

        const range = new Range()
        range.setStart(node, idx)
        range.setEnd(node, idx + keyword.length)
        ranges.push(range)

        totalMatches++
        pos = idx + 1
      }
    })

    // 添加所有匹配到高亮
    ranges.forEach((range, i) => {
      if (i === 0) {
        searchHighlightCurrent.add(range)
      } else {
        searchHighlight.add(range)
      }
    })

    currentRanges = ranges
    matchIndex = totalMatches > 0 ? 1 : 0
    matchCount.textContent = totalMatches > 0 ? `${matchIndex}/${totalMatches}` : '0/0'

    if (totalMatches > 0) {
      scrollToCurrent()
    }
  }

  let currentRanges: Range[] = []

  function scrollToCurrent(): void {
    if (currentRanges.length === 0) return

    const currentRange = currentRanges[matchIndex - 1]
    if (!currentRange) return

    // 获取滚动容器
    const scrollContainer = getSourceMode()
      ? getSourceElement()
      : document.getElementById('editor-container')
    if (!scrollContainer) return

    const rect = currentRange.getBoundingClientRect()
    const containerRect = scrollContainer.getBoundingClientRect()

    if (rect.top < containerRect.top || rect.bottom > containerRect.bottom) {
      const scrollOffset = rect.top - containerRect.top - containerRect.height / 2
      scrollContainer.scrollBy({ top: scrollOffset, behavior: 'smooth' })
    }
  }

  function updateHighlightIndex(): void {
    if (currentRanges.length === 0) return

    searchHighlight.clear()
    searchHighlightCurrent.clear()

    currentRanges.forEach((range, i) => {
      if (i === matchIndex - 1) {
        searchHighlightCurrent.add(range)
      } else {
        searchHighlight.add(range)
      }
    })

    scrollToCurrent()
  }

  // ---------- 统一接口 ----------
  function doHighlight(keyword: string): void {
    highlightAll(keyword)
  }

  function navigateNext(): void {
    if (totalMatches === 0) return
    matchIndex = matchIndex >= totalMatches ? 1 : matchIndex + 1
    matchCount.textContent = `${matchIndex}/${totalMatches}`
    updateHighlightIndex()
  }

  function navigatePrev(): void {
    if (totalMatches === 0) return
    matchIndex = matchIndex <= 1 ? totalMatches : matchIndex - 1
    matchCount.textContent = `${matchIndex}/${totalMatches}`
    updateHighlightIndex()
  }

  // ---------- 替换功能 ----------
  function toggleReplace(): void {
    replaceVisible = !replaceVisible
    replaceRow.style.display = replaceVisible ? 'flex' : 'none'
  }

  function replaceCurrent(): void {
    if (totalMatches === 0 || matchIndex === 0) return
    const replaceText = replaceInput.value
    const currentRange = currentRanges[matchIndex - 1]
    if (!currentRange) return

    if (getSourceMode()) {
      // 源码模式：用 execCommand 支持撤销
      replaceInSourceMode(currentRange, replaceText)
    } else {
      // 渲染模式：用 ProseMirror 事务
      replaceInRenderMode(currentRange, replaceText)
    }

    // 替换后重新搜索
    doHighlight(lastKeyword)
    if (totalMatches > 0) {
      matchIndex = matchIndex > totalMatches ? 1 : matchIndex
      matchCount.textContent = `${matchIndex}/${totalMatches}`
      updateHighlightIndex()
    }
  }

  function replaceAllMatches(): void {
    if (totalMatches === 0) return
    const replaceText = replaceInput.value
    const count = totalMatches

    if (getSourceMode()) {
      replaceAllInSourceMode(replaceText)
    } else {
      replaceAllInRenderMode(replaceText)
    }

    // 清除高亮并提示
    clearHighlights()
    currentRanges = []
    totalMatches = 0
    matchIndex = 0
    matchCount.textContent = '0/0'
    alert(`已替换 ${count} 处`)
  }

  function replaceInSourceMode(range: Range, replaceText: string): void {
    const sourceEl = getSourceElement()
    if (!sourceEl) return

    // 选中要替换的文本
    const selection = window.getSelection()
    if (!selection) return

    selection.removeAllRanges()
    selection.addRange(range)

    // 用 execCommand 替换，支持撤销
    document.execCommand('insertText', false, replaceText)
  }

  function replaceAllInSourceMode(replaceText: string): void {
    const sourceEl = getSourceElement()
    if (!sourceEl) return

    const text = sourceEl.textContent || ''
    const lowerText = text.toLowerCase()
    const lowerKeyword = lastKeyword.toLowerCase()

    let result = ''
    let lastIndex = 0
    let count = 0

    while (true) {
      const idx = lowerText.indexOf(lowerKeyword, lastIndex)
      if (idx === -1) break

      result += text.slice(lastIndex, idx) + replaceText
      lastIndex = idx + lastKeyword.length
      count++
    }

    if (count > 0) {
      result += text.slice(lastIndex)

      // 全选后用 execCommand 替换，作为一次撤销操作
      const selection = window.getSelection()
      if (!selection) return

      const range = document.createRange()
      range.selectNodeContents(sourceEl)
      selection.removeAllRanges()
      selection.addRange(range)

      document.execCommand('insertText', false, result)
    }
  }

  function replaceInRenderMode(range: Range, replaceText: string): void {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)

      // 使用 ProseMirror 的 posAtDOM 方法找到位置
      const pmFrom = view.posAtDOM(range.startContainer, range.startOffset)
      const pmTo = view.posAtDOM(range.endContainer, range.endOffset)

      if (pmFrom < 0 || pmTo < 0) return

      // 创建替换事务
      const tr = view.state.tr.insertText(replaceText, pmFrom, pmTo)
      view.dispatch(tr)
    })
  }

  function replaceAllInRenderMode(replaceText: string): void {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      let tr = view.state.tr

      // 从后往前替换，避免位置偏移
      const ranges = [...currentRanges].reverse()
      for (const range of ranges) {
        const pmFrom = view.posAtDOM(range.startContainer, range.startOffset)
        const pmTo = view.posAtDOM(range.endContainer, range.endOffset)

        if (pmFrom < 0 || pmTo < 0) continue

        tr = tr.insertText(replaceText, pmFrom, pmTo)
      }

      view.dispatch(tr)
    })
  }

  function show(): void {
    container.style.display = 'flex'
    input.focus()
    input.select()
    if (input.value.trim()) {
      lastKeyword = input.value.trim()
      doHighlight(lastKeyword)
    }
  }

  function hide(): void {
    container.style.display = 'none'
    replaceRow.style.display = 'none'
    replaceVisible = false
    clearHighlights()
    currentRanges = []
    totalMatches = 0
    matchIndex = 0
    matchCount.textContent = '0/0'
    // 聚焦回编辑区
    if (getSourceMode()) {
      getSourceElement()?.focus()
    } else {
      getEditorDom()?.focus()
    }
  }

  function toggle(): void {
    if (container.style.display === 'none') {
      show()
    } else {
      hide()
    }
  }

  // 搜索框输入
  input.addEventListener('input', () => {
    lastKeyword = input.value.trim()
    doHighlight(lastKeyword)
  })

  // 搜索框键盘事件
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        navigatePrev()
      } else {
        navigateNext()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      hide()
    }
  })

  // 替换框键盘事件
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      replaceCurrent()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      hide()
    }
  })

  btnNext.addEventListener('click', navigateNext)
  btnPrev.addEventListener('click', navigatePrev)
  btnClose.addEventListener('click', hide)
  btnToggleReplace.addEventListener('click', toggleReplace)
  btnReplace.addEventListener('click', replaceCurrent)
  btnReplaceAll.addEventListener('click', replaceAllMatches)

  return { container, show, hide, toggle, toggleReplace }
}
