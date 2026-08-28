/* ============================================================
 * 搜索栏组件：Ctrl+F 查找 / Esc 关闭 / Enter 下一个 / Shift+Enter 上一个
 * 渲染模式和源码模式统一使用 CSS Custom Highlight API
 * ============================================================ */

export interface SearchBar {
  container: HTMLElement
  show(): void
  hide(): void
  toggle(): void
}

export function createSearchBar(
  parent: HTMLElement,
  getSourceMode: () => boolean,
  getSourceElement: () => HTMLElement | null
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

  const btnClose = document.createElement('button')
  btnClose.type = 'button'
  btnClose.id = 'search-close'
  btnClose.title = '关闭 (Esc)'
  btnClose.textContent = '✕'

  container.append(input, matchCount, btnPrev, btnNext, btnClose)
  parent.appendChild(container)

  let matchIndex = 0
  let totalMatches = 0
  let lastKeyword = ''

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
      ? getSourceElement()?.parentElement
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

  btnNext.addEventListener('click', navigateNext)
  btnPrev.addEventListener('click', navigatePrev)
  btnClose.addEventListener('click', hide)

  return { container, show, hide, toggle }
}
