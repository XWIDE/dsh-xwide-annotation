// annotation-for-dsh 的浏览器端 half（client bundle）。
//
// 手写 CJS + ModuleLoader 包装（同 omdsh-dev navbar/greeter 模式，零构建
// 步骤）：纯 DOM 自渲染，无任何 @deepseek-ai 值导入（bundle purity gate 合规）；
// cordis 服务经 exports.inject 的字符串名接入（sessions / conversation /
// locale / uiSession——uiSession 用于读取「当前会话 id」：DSH 0.1.7 起
// sessions.list 快照不再带 current，见 apply 内的 readCurrentSessionId）。
//
// v1.4.x · 自包含批注流（取代 v0.9 chip 设计与 v1.0 发送面板）：
//   1. 选中助手文字 → 工具条「批注」→ 写批注（可留空 = 仅标记原文）
//   2. 保存后原文亮蓝编号 + 高亮（纯视觉，不弹窗）；跨消息/跨回合连续累积
//   3. 输入框旁「批注 ×N」标签：悬浮可见全部内容、可逐条删除
//   4. 回车发送：capture 阶段拦截 Enter（IME 守卫对齐官方 InputBar：isComposing /
//      keyCode 229 + compositionend 后短延迟 latch）→ 批注块 prepend 进草稿
//      （setDraft，不覆盖用户文字）→ composer 正常提交
//   5. 用户气泡不显示批注块：MutationObserver 微任务阶段（绘制前）按最后一个
//      「提问：」切掉批注块、贴「批注 ×N」标签（hover 可见）；1s 轮询兜底 +
//      历史消息自动修复（用户气泡是 MessageText 单文本节点，非 markdown）
//   6. 回复逐条对照：批注块末尾注入格式指令，模型按「Annotation N：…」逐条
//      回应；回复渲染完成（data-streaming 移除）后把「Annotation N：」替换为
//      可悬浮芯片（数据取最近一条带标签用户消息的 tag.__annotationItems，刷新
//      自动重建；改 DOM 前先快照 TreeWalker 收集的文本节点再逐个替换，遍历
//      中途 replaceChild 会让 walker 指针失效）
//   7. 语言跟随 DSH locale 服务（v1.4）：UI 文案与协议块 zh/en/ru 三语、实时切换，
//      隐藏手术与反解析同时兼容「提问：」/「Ask:」/「Вопрос:」与「问题：」老格式；
//      zh/en 之外的未知语言（fr、de…）走英文，绝不退回中文
//
// 消息格式（zh）：我批注了以下 N 处内容…\n\n1. 原文\n   批注：…\n\n
//           请用「Annotation 1：…」…\n\n提问：
// （en 用 I annotated the following N passage(s)… + Note: … + Ask:；
//   ru 用 Я аннотировал следующие фрагменты (N шт.)… + Примечание: … + Вопрос:，
//   但格式指令里的 «Annotation N: …» 三种语言都保留拉丁写法 —— 回复里按它做
//   芯片替换（decorateAnnotationLabels），与界面语言无关；
//   zh 分隔标记用「提问：」而非「问题：」——标题行「回答我的问题：」里也含
//   它，气泡隐藏手术会误命中）
//
// 发送清空只认 watchInputDraft 的「草稿有→空」迁移（未就绪时订阅重试补齐）；
// 气泡装饰走 MutationObserver + 轮询，只负责隐藏/贴标签，绝不清空待发送批注
// （历史消息重装饰与刚发送在 DOM 上不可区分，见 decorateAll）。
//
// 判别式与 omdsh-dev/navbar 一致：助手行 = [data-time-hover-root] 且不含
// user bubble（[class*="bubble"]）。
// focus-chat（@dingyi222666/dsh-focus-chat）兼容：其会话视图挂载在
// [data-focus-flow] 内，助手行 = class 含 "assistant" 的容器（CSS Modules
// 哈希名形如 `<hash>_assistant`，流式期间行自带 data-streaming），用户行
// 沿用 data-time-hover-root；切换视图 tab 时主视图会卸载，故行判别必须
// 同时覆盖两种视图结构（见 assistantRows / allMessageRows / assistantRowOf）。
window.__ModuleLoader__.load({
  // 必须与 package.json "name" 完全一致，否则 client-modules 报：
  // bundle loaded without registering "dsh-xwide-annotation"
  id: 'dsh-xwide-annotation',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    // ============================== 样式 ==============================
    var STYLE_ID = 'annotation-for-dsh-style'
    if (document.getElementById(STYLE_ID) === null) {
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '[data-annotation-for-dsh] { all: initial; }',
        '[data-annotation-for-dsh] * { box-sizing: border-box; }',
        '.dsh-ann-bar { position: fixed; z-index: 1200; display: flex; align-items: center;',
        '  gap: 2px; padding: 4px; border-radius: 12px;',
        '  border: 1px solid var(--dsw-alias-border-inverted);',
        '  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #2c2c2e));',
        '  box-shadow: var(--dsw-shadow-lv3);',
        '  font-family: var(--dsw-font-family, system-ui);',
        '  animation: dsh-ann-pop .12s var(--ds-ease-in-out, ease); }',
        '@keyframes dsh-ann-pop { from { opacity: 0; transform: translateY(3px); }',
        '  to { opacity: 1; transform: none; } }',
        '.dsh-ann-ghost { display: inline-flex; align-items: center; gap: 6px; height: 32px;',
        '  padding: 0 12px; border: none; border-radius: 16px; background: transparent;',
        '  color: var(--dsw-alias-label-primary); font-family: inherit;',
        '  font-size: 13px; line-height: 20px; cursor: pointer; }',
        '.dsh-ann-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-ann-ghost:disabled { opacity: .45; cursor: default; }',
        '.dsh-ann-ghost svg { width: 14px; height: 14px; }',
        '.dsh-ann-action { display: inline-flex; align-items: center; gap: 6px; height: 32px;',
        '  padding: 0 16px; border: none; border-radius: 16px;',
        '  background: var(--dsw-alias-button-primary-fill);',
        '  color: var(--dsw-alias-label-primary-foreground);',
        '  font-family: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }',
        '.dsh-ann-action:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }',
        '.dsh-ann-action:disabled { opacity: .4; cursor: default; }',
        '.dsh-ann-action svg { width: 14px; height: 14px; }',
        '.dsh-ann-icon { display: inline-flex; align-items: center; justify-content: center;',
        '  width: 28px; height: 28px; padding: 0; border: none; border-radius: 28px;',
        '  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }',
        '.dsh-ann-icon:hover { background: var(--dsw-alias-interactive-bg-hover);',
        '  color: var(--dsw-alias-label-secondary); }',
        '.dsh-ann-icon svg { width: 14px; height: 14px; }',
        '.dsh-ann-card { position: fixed; z-index: 1201; width: 440px;',
        '  max-width: calc(100vw - 16px); padding: 14px; border-radius: 14px;',
        '  border: 1px solid var(--dsw-alias-border-inverted);',
        '  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #2c2c2e));',
        '  box-shadow: var(--dsw-shadow-lv3);',
        '  font-family: var(--dsw-font-family, system-ui);',
        '  animation: dsh-ann-pop .12s var(--ds-ease-in-out, ease); }',
        '.dsh-ann-card-head { display: flex; align-items: center; justify-content: space-between;',
        '  margin-bottom: 8px; cursor: move; touch-action: none; user-select: none; }',
        '.dsh-ann-card-title { font-size: 15px; font-weight: 600;',
        '  color: var(--dsw-alias-label-primary); }',
        '.dsh-ann-card-headmain { display: flex; align-items: center; gap: 2px; min-width: 0; }',
        '.dsh-ann-quote { font-size: 13px; line-height: 1.6;',
        '  color: var(--dsw-alias-label-tertiary);',
        '  border-left: 2px solid var(--dsw-alias-border-inverted);',
        '  background: var(--dsw-alias-bg-layer-1);',
        '  border-radius: 0 8px 8px 0; padding: 6px 10px; margin-bottom: 8px;',
        '  max-height: 72px; overflow: hidden; word-break: break-word;',
        '  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }',
        '.dsh-ann-quotes { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px;',
        '  max-height: 150px; overflow-y: auto; }',
        '.dsh-ann-qitem { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px;',
        '  border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }',
        '.dsh-ann-qnum { flex: none; display: inline-flex; align-items: center; justify-content: center;',
        '  width: 16px; height: 16px; margin-top: 1px; border-radius: 8px;',
        '  background: var(--dsw-alias-text-accent, #4c9aff); color: #fff;',
        '  font-size: 12px; font-weight: 700; }',
        '.dsh-ann-qbody { flex: 1; min-width: 0; }',
        '.dsh-ann-qtext { font-size: 12px; line-height: 1.5;',
        '  color: var(--dsw-alias-label-tertiary); max-height: 36px; overflow: hidden;',
        '  word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2;',
        '  -webkit-box-orient: vertical; }',
        '.dsh-ann-qnote { font-size: 12px; line-height: 1.5; margin-top: 2px;',
        '  color: var(--dsw-alias-label-secondary); max-height: 34px; overflow: hidden;',
        '  word-break: break-word; white-space: pre-wrap; display: -webkit-box;',
        '  -webkit-line-clamp: 2; -webkit-box-orient: vertical; }',
        '.dsh-ann-qdel { flex: none; display: inline-flex; align-items: center; justify-content: center;',
        '  width: 28px; height: 28px; padding: 0; border: none; border-radius: 14px;',
        '  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }',
        '.dsh-ann-qdel:hover { background: var(--dsw-alias-interactive-bg-hover);',
        '  color: var(--dsw-alias-label-secondary); }',
        '.dsh-ann-qdel svg { width: 12px; height: 12px; }',
        '.dsh-ann-input { width: 100%; min-height: 84px; padding: 10px 12px;',
        '  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;',
        '  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);',
        '  font-family: inherit; font-size: 14px; line-height: 22px;',
        '  outline: none; resize: vertical; transition: border-color .15s ease; }',
        '.dsh-ann-input:focus { border-color: var(--dsw-alias-text-accent, #4c9aff); }',
        '.dsh-ann-input::placeholder { color: var(--dsw-alias-label-dimmed); }',
        '.dsh-ann-row { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }',
        '.dsh-ann-error { color: var(--dsw-alias-state-error-primary, #ff7a7a);',
        '  font-size: 12px; margin-top: 8px; word-break: break-word; }',
        '.dsh-ann-hl { position: fixed; z-index: 900; background: rgba(255, 195, 0, .15);',
        '  border-radius: 2px; pointer-events: none; animation: dsh-ann-fadein .15s ease; }',
        '.dsh-ann-num { position: fixed; z-index: 940; display: inline-flex; align-items: center;',
        '  justify-content: center; min-width: 16px; height: 16px; padding: 0 4px;',
        '  border-radius: 8px; border: 1px solid rgba(255, 255, 255, .3);',
        '  background: var(--dsw-alias-text-accent, #4c9aff); color: #fff;',
        '  font-family: var(--dsw-font-family, system-ui); font-size: 12px; font-weight: 700;',
        '  box-shadow: 0 1px 4px rgba(0,0,0,.35); pointer-events: auto; cursor: pointer;',
        '  transition: filter .12s ease; }',
        '.dsh-ann-num:hover { filter: brightness(1.15); }',
        'body:has([role="dialog"][aria-modal="true"]) [data-annotation-overlay],',
        'body:has([role="dialog"][aria-modal="true"]) [data-annotation-num-layer] { display: none; }',
        '.dsh-ann-tip { animation: dsh-ann-pop .12s var(--ds-ease-in-out, ease); }',
        // 可交互浮层始终使用不透明主题底色；菜单 token 在新版宿主可能带 alpha，
        // 默认状态、键盘聚焦和鼠标悬停都不能让正文穿透影响可读性。
        '@keyframes dsh-ann-fadein { from { opacity: 0; } to { opacity: 1; } }',
      ].join('\n')
      document.head.appendChild(style)
    }

    // ============================== i18n（zh / en） ==============================
    // UI 文案与批注协议块双语化：当前语言由 DSH 的 locale 服务驱动
    // （ctx.locale.getSnapshot().active + subscribe()），服务缺失时回退 zh。
    // 历史消息的隐藏手术与反解析同时兼容 zh/en 标记，跨语言切换不丢批注。
    var STR = {
      zh: {
        actions: {
          annotate: '批注',
          already: '已批注',
          annotateTitle: '为选中的内容写一条批注',
          alreadyTitle: '这段内容已在批注清单中',
        },
        edit: {
          addTitle: '添加批注',
          editTitle: '编辑批注',
          placeholder: '写下批注…（可留空，保存后仅标记原文）',
          save: '保存批注',
          delete: '删除这条批注',
        },
        common: { cancel: '取消' },
        error: { noSelection: '没有选中的内容' },
        chip: { count: '条批注' },
        tip: { title: '批注（{n} 条）', notePrefix: '批注：', del: '删' },
        bubble: { tag: '批注 ×{n}', title: '本消息携带批注（{n} 条）' },
        reply: {
          headWithQuote: '批注 {n} 的原文',
          notePrefix: '你的批注：',
        },
        toast: {
          attachFail: '批注拼稿失败，消息将不带批注发送：',
          skipCommand: '本条是斜杠命令，未拼入批注；批注已保留，将随下一条消息发送',
          noSession: '无法确定当前会话，批注未拼入（已保留，将随下一条消息重试）',
        },
        block: {
          head: '我批注了以下 {n} 处内容（编号与原文对应），请针对它们回答我的问题：',
          notePrefix: '批注：',
          format: '请用「Annotation 1：…」到「Annotation {n}：…」的格式，逐条回应上面每一条批注，最后再回答我的问题。',
          headOnly: '我批注了以下内容，请逐条回应：',
          formatOnly: '请按「Annotation N：…」的格式，逐条回应以上批注。',
          marker: '提问：',
        },
      },
      en: {
        actions: {
          annotate: 'Annotate',
          already: 'Annotated',
          annotateTitle: 'Write a note about the selected text',
          alreadyTitle: 'This passage is already in your annotation list',
        },
        edit: {
          addTitle: 'Add annotation',
          editTitle: 'Edit annotation',
          placeholder: 'Write a note… (optional; saving only marks the passage)',
          save: 'Save annotation',
          delete: 'Delete this annotation',
        },
        common: { cancel: 'Cancel' },
        error: { noSelection: 'No text selected' },
        chip: { count: ' annotation(s)' },
        tip: { title: 'Annotations ({n})', notePrefix: 'Note: ', del: 'Del' },
        bubble: { tag: 'Annotations ×{n}', title: 'This message carries {n} annotation(s)' },
        reply: {
          headWithQuote: 'Source of annotation {n}',
          notePrefix: 'Your note: ',
        },
        toast: {
          attachFail: 'Failed to attach annotations; the message will be sent without them: ',
          skipCommand: 'Slash command detected — annotations stay pending and will attach to your next message',
          noSession: 'Cannot determine the current session; annotations kept pending and will retry with your next message',
        },
        block: {
          head: 'I annotated the following {n} passage(s) (the numbers match the quotes below); please respond to them when answering my question:',
          notePrefix: 'Note: ',
          format: 'Please respond to each annotation in the format "Annotation 1: …" through "Annotation {n}: …", then answer my question.',
          headOnly: 'I annotated the following passages; please respond to each annotation:',
          formatOnly: 'Please respond to each annotation above in the format "Annotation N: …".',
          marker: 'Ask:',
        },
      },
      ru: {
        actions: {
          annotate: 'Аннотировать',
          already: 'Уже аннотировано',
          annotateTitle: 'Написать примечание к выделенному тексту',
          alreadyTitle: 'Этот фрагмент уже в списке аннотаций',
        },
        edit: {
          addTitle: 'Добавить аннотацию',
          editTitle: 'Изменить аннотацию',
          placeholder: 'Примечание… (можно пустым: тогда фрагмент просто помечается)',
          save: 'Сохранить аннотацию',
        },
        common: { cancel: 'Отмена' },
        error: { noSelection: 'Текст не выделен' },
        // Три формы через «|» — их выбирает plural() по числу; у zh/en форма одна
        // (строка без «|»), поэтому их вывод не меняется.
        chip: { count: ' аннотация| аннотации| аннотаций' },
        tip: { title: 'Аннотации ({n})', notePrefix: 'Примечание: ', del: 'Удал.' },
        bubble: { tag: 'Аннотации ×{n}', title: 'В этом сообщении аннотаций: {n}' },
        reply: {
          headWithQuote: 'Источник аннотации {n}',
          headNoQuote: 'Аннотация {n}',
          notePrefix: 'Ваше примечание: ',
          missing: '(подходящая аннотация не найдена)',
        },
        toast: {
          attachFail: 'Не удалось собрать аннотации; сообщение уйдёт без них: ',
          skipCommand: 'Это слэш-команда — аннотации остаются в очереди и уйдут со следующим сообщением',
        },
        // Разбор блока опирается на три вещи: заголовок начинается с BLOCK_HEADS.ru,
        // разделитель вопроса — block.marker, префикс примечания — notePrefix.
        // Формат ответа модели намеренно латинский («Annotation N: …»): по нему
        // работает замена в ответе ассистента (decorateAnnotationLabels), и он не
        // зависит от языка интерфейса.
        block: {
          head: 'Я аннотировал следующие фрагменты ({n} шт.) — номера соответствуют цитатам ниже; пожалуйста, ответьте на них, отвечая на мой вопрос:',
          notePrefix: 'Примечание: ',
          format: 'Ответьте на каждую аннотацию в формате «Annotation 1: …» — «Annotation {n}: …», затем ответьте на мой вопрос.',
          headOnly: 'Я аннотировал следующие фрагменты — ответьте, пожалуйста, на каждую аннотацию:',
          formatOnly: 'Ответьте на каждую аннотацию выше в формате «Annotation N: …».',
          marker: 'Вопрос:',
        },
      },
    }
    var currentLang = 'zh'
    function setLang(id) {
      // 文案有 zh / en / ru 三套，DSH 的 locale 服务可能有更多（fr、de…）。
      // 已知语言原样采用；未知语言走英文 —— 曾经这里把一切非 zh/en 都当成 zh，
      // 选了俄语的节点整套批注界面退回中文。
      currentLang = (id === 'zh' || id === 'en' || id === 'ru') ? id : 'en'
    }
    function dictVal(lang, key) {
      var cur = STR[lang]
      var parts = key.split('.')
      for (var i = 0; i < parts.length; i++) {
        if (cur === undefined || cur === null) return undefined
        cur = cur[parts[i]]
      }
      return cur
    }
    /** @param {string} key @param {Object<string, string|number>} [params] */
    function t(key, params) {
      var s = dictVal(currentLang, key)
      if (s === undefined) s = dictVal('zh', key)
      if (s === undefined) s = key
      if (params !== undefined && params !== null) {
        for (var k in params) {
          if (Object.prototype.hasOwnProperty.call(params, k)) {
            s = s.split('{' + k + '}').join(String(params[k]))
          }
        }
      }
      return s
    }
    /** Числовая форма из словаря: «одна|две|много» через «|»; без «|» — как есть.
     *  Нужна для русского: «1 аннотация», «3 аннотации», «5 аннотаций». */
    function plural(key, n) {
      var forms = String(t(key)).split('|')
      if (forms.length < 3) return forms[0]
      var mod10 = n % 10
      var mod100 = n % 100
      var index = (mod10 === 1 && mod100 !== 11) ? 0
        : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) ? 1 : 2
      return forms[index] !== undefined ? forms[index] : forms[0]
    }
    // 批注块头部哨兵（zh/en/ru 都识别；兼容历史消息与跨语言切换）。
    var BLOCK_HEADS = { zh: '我批注了以下', en: 'I annotated the following', ru: 'Я аннотировал следующие' }
    function hasAnnotationBlock(text) {
      for (var lang in BLOCK_HEADS) {
        if (Object.prototype.hasOwnProperty.call(BLOCK_HEADS, lang) && text.indexOf(BLOCK_HEADS[lang]) !== -1) return true
      }
      return false
    }
    // 气泡隐藏手术的分隔标记：当前语言优先，另保留其他语言与「问题：」老格式。
    var BLOCK_MARKERS = {
      zh: ['\n提问：', '提问：', '\n问题：', '问题：'],
      en: ['\nAsk:', 'Ask:'],
      ru: ['\nВопрос:', 'Вопрос:'],
    }
    function blockMarkers() {
      var langs = [currentLang]
      var known = Object.keys(BLOCK_MARKERS)
      for (var k = 0; k < known.length; k++) if (langs.indexOf(known[k]) === -1) langs.push(known[k])
      var out = []
      for (var i = 0; i < langs.length; i++) out = out.concat(BLOCK_MARKERS[langs[i]])
      return out
    }
    // 反解析用的段落级分隔标记（批注块按协议生成，均以 \n\n 开头）。
    var PARSE_MARKERS = ['\n\n提问：', '\n\n问题：', '\n\nAsk:', '\n\nВопрос:']

    // ============================== 工具 ==============================
    // 助手行判别：0810 snapshot 起助手消息行 = ChatNodeSeat 上的
    // data-chat-flow-kind="assistant-step"（旧版 data-time-hover-root 已不再
    // 出现在助手消息主体上，只留在用户行与 turn 尾节点）；保留旧判别式兜底
    // 兼容回滚旧 snapshot，并排除新版 data-turn-tail 误判。
    function isAssistantRow(el) {
      if (el.matches('[data-chat-flow-kind="assistant-step"]')) return true
      return el.hasAttribute('data-time-hover-root')
        && el.querySelector('[class*="bubble"]') === null
        && !el.hasAttribute('data-turn-tail')
    }

    // ---------- focus-chat（@dingyi222666/dsh-focus-chat）视图兼容 ----------
    // 该插件在 conversation.view 槽注册「聚焦会话」视图：挂载于
    // [data-focus-flow]（列容器）→ [data-focus-anchor-key]（行包装）→ 行。
    // 助手行 = class 含 "assistant" 的容器（CSS Modules 哈希名保留 local 名，
    // 形如 `<hash>_assistant`；流式期间行自带 data-streaming，停流后移除）。
    // 用户行保留 data-time-hover-root + [class*="bubble"]，与旧判别式一致。
    function isFocusFlow(el) {
      return el !== null && typeof el.closest === 'function'
        && el.closest('[data-focus-flow]') !== null
    }

    function isFocusAssistantRow(el) {
      if (el === null || !el.classList || !isFocusFlow(el)) return false
      for (var i = 0; i < el.classList.length; i++) {
        if (el.classList[i].indexOf('assistant') !== -1) return true
      }
      return false
    }

    /** focus 视图的全部消息行（用户 + 助手，DOM 顺序）。只保留最外层助手
     *  容器（markdown 内部子元素也可能带含 assistant 的类名）。 */
    function focusMessageRows() {
      var flow = document.querySelector('[data-focus-flow]')
      if (flow === null) return []
      var out = []
      var all = flow.querySelectorAll('[data-time-hover-root], [class*="assistant"]')
      for (var i = 0; i < all.length; i++) {
        var el = all[i]
        if (el.hasAttribute('data-time-hover-root')) {
          if (!isAssistantRow(el)) out.push(el)
          continue
        }
        if (!isFocusAssistantRow(el)) continue
        var p = el.parentElement
        if (p !== null && p !== flow && isFocusAssistantRow(p)) continue
        out.push(el)
      }
      return out
    }

    function assistantRowOf(node) {
      var el = (node instanceof Element) ? node : (node !== null ? node.parentElement : null)
      while (el !== null && el !== document.body) {
        if (el.hasAttribute('data-chat-flow-kind')) {
          return el.getAttribute('data-chat-flow-kind') === 'assistant-step' ? el : null
        }
        if (el.hasAttribute('data-time-hover-root')) {
          return isAssistantRow(el) ? el : null
        }
        if (isFocusAssistantRow(el)) {
          // 冒到最外层 focus 助手容器（内部子元素可能也含 assistant 类名）。
          while (el.parentElement !== null && el.parentElement !== document.body
            && isFocusAssistantRow(el.parentElement)) {
            el = el.parentElement
          }
          return el
        }
        el = el.parentElement
      }
      return null
    }

    // 只接管宿主的可选文本正文；标题、按钮、PDF 和 iframe 不属于此接口。
    var DOCUMENT_TEXT = '[data-textpreview-plain], [data-document-markdown], [data-code-preview] pre'

    function documentSourceOf(node) {
      var el = node instanceof Element ? node : node && node.parentElement
      if (el && el.closest('button, input, textarea, [contenteditable="true"]')) return null
      var root = el && el.closest(DOCUMENT_TEXT)
      var preview = root && root.closest('[data-textpreview-url]')
      if (!preview) return null
      var url = preview.getAttribute('data-textpreview-url') || ''
      var match = /^dsh-resource:\/\/file\/session\/([^/]+)\/(.+)$/.exec(url)
      if (!match) return null
      try {
        var sessionId = decodeURIComponent(match[1])
        var path = match[2].split('/').map(decodeURIComponent).join('/')
        if (/[\u0000-\u001f\u007f]/.test(path) || /[?#]/.test(url)) return null
        return { root: root, sourceUrl: url, sourcePath: path, sessionId: sessionId }
      } catch (_) { return null }
    }

    function annotationRootOf(node) {
      var source = documentSourceOf(node)
      return source !== null ? source.root : assistantRowOf(node)
    }

    function quoteRects(range, saved) {
      var rects = Array.from(range.getClientRects())
      if (!saved.sourceUrl) return rects
      var clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      var node = range.commonAncestorContainer
      var el = node instanceof Element ? node : node.parentElement
      for (; el && el !== document.body; el = el.parentElement) {
        var style = getComputedStyle(el)
        var box = el.getBoundingClientRect()
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
          clip.left = Math.max(clip.left, box.left); clip.right = Math.min(clip.right, box.right)
        }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
          clip.top = Math.max(clip.top, box.top); clip.bottom = Math.min(clip.bottom, box.bottom)
        }
      }
      return rects.map(function (r) {
        var left = Math.max(r.left, clip.left), top = Math.max(r.top, clip.top)
        return new DOMRect(left, top, Math.max(0, Math.min(r.right, clip.right) - left), Math.max(0, Math.min(r.bottom, clip.bottom) - top))
      }).filter(function (r) { return r.width > 0 && r.height > 0 })
    }

    function quoteWithSource(q) {
      return q.sourcePath ? '[' + q.sourcePath + ']\n' + q.text : q.text
    }

    function assistantRows() {
      var modern = document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')
      if (modern.length > 0) return Array.prototype.slice.call(modern)
      var focus = focusMessageRows().filter(isFocusAssistantRow)
      if (focus.length > 0) return focus
      return Array.prototype.slice.call(document.querySelectorAll('[data-time-hover-root]'))
        .filter(isAssistantRow)
    }

    /** 全部消息行（用户 + 助手 + 其它节点）：新版走 data-chat-flow-kind，
     *  旧版回退 data-time-hover-root；focus-chat 视图单独按 DOM 顺序收集
     *  （会话视图 tab 切换时主视图会卸载，两种结构不同时存在）。
     *  用于气泡装饰、批注条目回溯。 */
    function allMessageRows() {
      var modern = document.querySelectorAll('[data-chat-flow-kind]')
      if (modern.length > 0) return Array.prototype.slice.call(modern)
      var focus = focusMessageRows()
      if (focus.length > 0) return focus
      return Array.prototype.slice.call(document.querySelectorAll('[data-time-hover-root]'))
    }

    /** 由字符偏移在元素内构造 Range（跨文本节点）。 */
    function rangeFromOffset(el, offset, length) {
      var nodes = []
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      var n
      while ((n = walker.nextNode()) !== null) nodes.push(n)
      var pos = 0
      for (var i = 0; i < nodes.length; i++) {
        var len = (nodes[i].nodeValue || '').length
        if (offset < pos + len) {
          var range = document.createRange()
          range.setStart(nodes[i], offset - pos)
          var remain = length
          var j = i
          var inner = offset - pos
          while (remain > 0) {
            var l = (nodes[j].nodeValue || '').length
            var take = Math.min(remain, l - inner)
            remain -= take
            if (remain === 0) { range.setEnd(nodes[j], inner + take); break }
            j++
            inner = 0
          }
          return range
        }
        pos += len
      }
      return null
    }

    function findRangeIn(el, quote) {
      var full = ''
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      var n
      while ((n = walker.nextNode()) !== null) full += n.nodeValue || ''
      var start = full.indexOf(quote)
      if (start === -1) return null
      return rangeFromOffset(el, start, quote.length)
    }

    /** 空白完全剥离匹配：返回 quote 在 full 中的所有原始偏移区间 [{start,end}]。
     *  解决选区文本跨块级元素（GenUI 表格单元格等）带出 \n、而 DOM textContent
     *  无此空白导致的匹配失败（此前会掉进宽松匹配命中旧轮次）。 */
    function allNormSpans(full, quote) {
      var nq = quote.replace(/\s+/g, '')
      if (nq === '') return []
      var nf = ''
      var map = []
      for (var i = 0; i < full.length; i++) {
        if (!/\s/.test(full[i])) { nf += full[i]; map.push(i) }
      }
      var out = []
      var idx = nf.indexOf(nq)
      while (idx !== -1) {
        out.push({ start: map[idx], end: map[idx + nq.length - 1] + 1 })
        idx = nf.indexOf(nq, idx + 1)
      }
      return out
    }

    function findNormSpan(full, quote) {
      var spans = allNormSpans(full, quote)
      return spans.length > 0 ? spans[0] : null
    }

    /** 批注芯片差异变体：选区文本里芯片是「Annotation N」（无冒号），而消息行
     *  渲染文本可能是「Annotation N：」（React 重渲染后冒号恢复）——匹配失败时
     *  用变体重试，抹平该差异。 */
    function quoteVariants(quote) {
      var out = [quote]
      var re = /Annotation[\s\u200b\u200c\u200d\u00ad]*(\d+)/gi
      var m
      while ((m = re.exec(quote)) !== null) {
        out.push(quote.slice(0, m.index) + 'Annotation ' + m[1] + '：' + quote.slice(m.index + m[0].length))
      }
      return out
    }

    function allPositionsOf(el, quote) {
      var full = el.textContent || ''
      var out = []
      var idx = full.indexOf(quote)
      while (idx !== -1) {
        out.push(idx)
        idx = full.indexOf(quote, idx + 1)
      }
      return out
    }

    function ctxScore(full, pos, len, ctx) {
      if (ctx === null) return 0
      var before = full.slice(Math.max(0, pos - 24), pos)
      var after = full.slice(pos + len, pos + len + 24)
      var s = 0
      for (var i = 0; i < Math.min(before.length, ctx.before.length); i++) {
        if (before[i] === ctx.before[i]) s++
      }
      for (var j = 0; j < Math.min(after.length, ctx.after.length); j++) {
        if (after[j] === ctx.after[j]) s++
      }
      return s
    }

    /** 由 Range 起点算出它在元素文本内的绝对字符偏移（真实位置）。 */
    function offsetOfRangeInRow(row, range) {
      try {
        var walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        var n
        var pos = 0
        while ((n = walker.nextNode()) !== null) {
          var len = (n.nodeValue || '').length
          if (n === range.startContainer) return pos + range.startOffset
          pos += len
        }
      } catch (_) { /* fallthrough */ }
      return -1
    }

    /** 宽松定位：token 式匹配，双向容忍空白差异。 */
    function findRangeFlexible(el, quote) {
      var qNorm = quote.replace(/\s+/g, ' ').trim()
      if (qNorm === '') return null
      var tokens = qNorm.split(' ').filter(function (t) { return t !== '' })
      if (tokens.length === 0) return null
      var nodes = []
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      var n
      while ((n = walker.nextNode()) !== null) nodes.push(n)
      var stream = []
      for (var i = 0; i < nodes.length; i++) {
        var text = nodes[i].nodeValue || ''
        for (var k = 0; k < text.length; k++) stream.push({ node: nodes[i], offset: k, ch: text[k] })
      }
      var t = 0
      var ti = 0
      var startNode = null
      var startOff = 0
      var endNode = null
      var endOff = -1
      var seenGap = false
      for (var s = 0; s < stream.length && t < tokens.length; s++) {
        var ch = stream[s].ch
        var isWs = /\s/.test(ch)
        if (isWs) {
          if (ti === 0) seenGap = true
          continue
        }
        if (ti === 0) {
          if (t > 0 && !seenGap) seenGap = true
          if (ch === tokens[t][0]) {
            if (t === 0) { startNode = stream[s].node; startOff = stream[s].offset }
            ti = 1
          } else {
            seenGap = true
            continue
          }
          if (tokens[t].length === 1) {
            endNode = stream[s].node
            endOff = stream[s].offset
            t++
            ti = 0
            seenGap = false
          }
          continue
        }
        if (ch === tokens[t][ti]) {
          ti++
          if (ti === tokens[t].length) {
            endNode = stream[s].node
            endOff = stream[s].offset
            t++
            ti = 0
            seenGap = false
          }
        } else {
          ti = 0
          if (ch === tokens[t][0]) {
            if (t === 0) { startNode = stream[s].node; startOff = stream[s].offset }
            ti = 1
            if (tokens[t].length === 1) {
              endNode = stream[s].node
              endOff = stream[s].offset
              t++
              ti = 0
              seenGap = false
            }
          }
        }
      }
      if (t === tokens.length && startNode !== null) {
        var range = document.createRange()
        range.setStart(startNode, startOff)
        range.setEnd(endNode, endOff + 1)
        return range
      }
      return null
    }

    /** 定位批注的 Range：消息 seq 锚定优先，空白不敏感重搜兜底。 */
    function locateQuote(quote, saved) {
      if (saved && saved.sourceUrl) {
        var bodies = document.querySelectorAll(DOCUMENT_TEXT)
        for (var d = 0; d < bodies.length; d++) {
          var source = documentSourceOf(bodies[d])
          if (source === null || source.sourceUrl !== saved.sourceUrl || bodies[d].getClientRects().length === 0) continue
          if (saved.range && bodies[d].contains(saved.range.commonAncestorContainer)
            && saved.range.toString().trim() === quote) return saved.range
          if (saved.textOffset >= 0) {
            var exact = rangeFromOffset(bodies[d], saved.textOffset, quote.length)
            if (exact !== null && exact.toString() === quote) return exact
          }
          // 文件变化后只接受唯一匹配，避免标记重复代码中的另一处。
          var text = bodies[d].textContent || ''
          var at = text.indexOf(quote)
          if (at >= 0 && text.indexOf(quote, at + 1) === -1) return rangeFromOffset(bodies[d], at, quote.length)
        }
        return null
      }
      if (saved !== undefined && saved !== null && saved.range && saved.range.startContainer) {
        try {
          if (saved.range.startContainer.isConnected && saved.range.endContainer.isConnected) {
            var t = saved.range.toString()
            if (t.replace(/\s+/g, '') === quote.replace(/\s+/g, '')) {
              return saved.range
            }
          }
        } catch (_) { /* range 已失效 */ }
      }
      var rows = assistantRows()
      if (saved !== undefined && saved !== null && saved.seqKey !== '') {
        try {
          var item = document.querySelector('[data-chat-anchor-key="' + saved.seqKey + '"]')
          // focus-chat 视图的锚 key 属性名不同，值语义一致。
          if (item === null) {
            item = document.querySelector('[data-focus-anchor-key="' + saved.seqKey + '"]')
          }
          if (item !== null) {
            var itText = item.textContent || ''
            if (saved.textOffset >= 0) {
              var sp0 = findNormSpan(itText, quote)
              if (sp0 !== null && Math.abs(sp0.start - saved.textOffset) <= 2) {
                var itRange = rangeFromOffset(item, sp0.start, sp0.end - sp0.start)
                if (itRange !== null) return itRange
              }
            }
            if (saved.ctxBefore !== '') {
              var itIdx = itText.indexOf(saved.ctxBefore)
              if (itIdx !== -1) {
                var itNear = itIdx + saved.ctxBefore.length
                var sp1 = findNormSpan(itText.slice(itNear), quote)
                if (sp1 !== null) {
                  var itRange2 = rangeFromOffset(item, itNear + sp1.start, sp1.end - sp1.start)
                  if (itRange2 !== null) return itRange2
                }
              }
            }
            // 锚点消息内的全量扫描（空白不敏感 + 上下文评分）。
            var spansIt = allNormSpans(itText, quote)
            var bestIt = null
            var bestItScore = -1
            for (var pp2 = 0; pp2 < spansIt.length; pp2++) {
              var rngIt = rangeFromOffset(item, spansIt[pp2].start, spansIt[pp2].end - spansIt[pp2].start)
              if (rngIt === null) continue
              var scIt = ctxScore(itText, spansIt[pp2].start, spansIt[pp2].end - spansIt[pp2].start,
                { before: saved.ctxBefore || '', after: saved.ctxAfter || '' })
              if (scIt > bestItScore) { bestItScore = scIt; bestIt = rngIt }
            }
            if (bestIt !== null && (saved.ctxBefore === '' || bestItScore > 0)) return bestIt
            // 锚点消息还在但原文匹配不上：先试批注芯片差异变体（「Annotation N」
            // vs「Annotation N：」）在**同一条消息内**宽松重定位——绝不跨消息
            // 模糊搜索（那是「跳到旧轮次」的根源，v1.3.6 纪律）。
            var variants = quoteVariants(quote)
            for (var vi = 0; vi < variants.length; vi++) {
              var vsp = allNormSpans(itText, variants[vi])
              for (var vj = 0; vj < vsp.length; vj++) {
                var vrng = rangeFromOffset(item, vsp[vj].start, vsp[vj].end - vsp[vj].start)
                if (vrng !== null) return vrng
              }
              var vflex = findRangeFlexible(item, variants[vi])
              if (vflex !== null) return vflex
            }
            // 同消息内确实定位不到 → 放弃（脚标隐藏）。
            return null
          }
        } catch (_) { return null }
      }
      if (saved !== undefined && saved !== null && saved.rowHead !== '') {
        for (var r = 0; r < rows.length; r++) {
          var rowText = rows[r].textContent || ''
          if (rowText.slice(0, 24) !== saved.rowHead) continue
          if (saved.textOffset >= 0) {
            var spR = findNormSpan(rowText, quote)
            if (spR !== null && Math.abs(spR.start - saved.textOffset) <= 2) {
              var range = rangeFromOffset(rows[r], spR.start, spR.end - spR.start)
              if (range !== null) return range
            }
          }
          if (saved.ctxBefore !== '') {
            var bIdx = rowText.indexOf(saved.ctxBefore)
            if (bIdx !== -1) {
              var near = bIdx + saved.ctxBefore.length
              var spR2 = findNormSpan(rowText.slice(near), quote)
              if (spR2 !== null) {
                var range2 = rangeFromOffset(rows[r], near + spR2.start, spR2.end - spR2.start)
                if (range2 !== null) return range2
              }
            }
          }
          var spans = allNormSpans(rowText, quote)
          var bestRow = null
          var bestRowScore = -1
          for (var pp = 0; pp < spans.length; pp++) {
            var rng = rangeFromOffset(rows[r], spans[pp].start, spans[pp].end - spans[pp].start)
            if (rng === null) continue
            var sc = ctxScore(rowText, spans[pp].start, spans[pp].end - spans[pp].start,
              saved !== undefined && saved !== null
                ? { before: saved.ctxBefore || '', after: saved.ctxAfter || '' }
                : null)
            if (sc > bestRowScore) { bestRowScore = sc; bestRow = rng }
          }
          if (bestRow !== null) return bestRow
        }
      }
      var ctx = saved !== undefined && saved !== null
        ? { before: saved.ctxBefore || '', after: saved.ctxAfter || '' }
        : null
      var best = null
      var bestScore = -1
      for (var i = 0; i < rows.length; i++) {
        var full = rows[i].textContent || ''
        var spans = allNormSpans(full, quote)
        for (var p = 0; p < spans.length; p++) {
          var range = rangeFromOffset(rows[i], spans[p].start, spans[p].end - spans[p].start)
          if (range === null) continue
          var score = ctxScore(full, spans[p].start, spans[p].end - spans[p].start, ctx)
          if (score > bestScore) { bestScore = score; best = range }
        }
      }
      if (best !== null && (ctx === null || bestScore > 0)) return best
      var flow = document.querySelector('[data-chat-flow]')
      if (flow === null) flow = document.querySelector('[data-focus-flow]')
      if (flow !== null) {
        var full2 = flow.textContent || ''
        var positions2 = allPositionsOf(flow, quote)
        var best2 = null
        var bestScore2 = -1
        for (var q2 = 0; q2 < positions2.length; q2++) {
          var range2 = rangeFromOffset(flow, positions2[q2], quote.length)
          if (range2 === null) continue
          var score2 = ctxScore(full2, positions2[q2], quote.length, ctx)
          if (score2 > bestScore2) { bestScore2 = score2; best2 = range2 }
        }
        if (best2 !== null && (ctx === null || bestScore2 > 0)) return best2
      }
      return null
    }

    function truncate(s, n) {
      return s.length > n ? s.slice(0, n) + '…' : s
    }

    function placeAbove(rect, height) {
      var w = 400
      var left = rect.left + rect.width / 2 - w / 2
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
      // 下方优先：原生选中菜单（移动端长按菜单、桌面 Copy/Search 浮层）锚定在选区
      // 上沿附近，且原生 UI 恒绘制在页面内容之上（z-index 无效），工具条放上方必被
      // 遮挡；因此下方放得下就放下方，放不下才回上方。
      var belowTop = rect.bottom + 8
      var belowFits = belowTop + height <= window.innerHeight - 8
      var top
      if (belowFits) {
        top = belowTop
      } else {
        top = rect.top - height - 8
        if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - height - 8)
      }
      return { left: Math.round(left), top: Math.round(Math.max(8, top)) }
    }

    function svg(paths, viewBox) {
      var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      s.setAttribute('viewBox', viewBox)
      s.setAttribute('fill', 'none')
      s.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      for (var i = 0; i < paths.length; i++) {
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        p.setAttribute('d', paths[i])
        p.setAttribute('fill', 'currentColor')
        s.appendChild(p)
      }
      return s
    }
    var ICONS = {
      plus: function () {
        return svg(['M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z'], '0 0 16 16')
      },
      check: function () {
        return svg([
          'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z',
        ], '0 0 16 16')
      },
      close: function () {
        return svg([
          'M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197Z',
          'M13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z',
        ], '0 0 16 16')
      },
      send: function () {
        return svg([
          'M8.3125 0.981587C8.66767 1.0545 8.97902 1.20558 9.2627 1.43374C9.48724 1.61438 9.73029 1.85933 9.97949 2.10854L14.707 6.83608L13.293 8.25014L9 3.95717V15.0431H7V3.95717L2.70703 8.25014L1.29297 6.83608L6.02051 2.10854C6.26971 1.85933 6.51277 1.61438 6.7373 1.43374C6.97662 1.24126 7.28445 1.04542 7.6875 0.981587C7.8973 0.94841 8.1031 0.956564 8.3125 0.981587Z',
        ], '0 0 16 16')
      },
      trash: function () {
        return svg([
          'M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z',
        ], '0 0 16 16')
      },
    }

    var PENDING_STORAGE_PREFIX = 'dsh.annotation.pending.v1.'

    function pendingStorageKey(sessionId) {
      return PENDING_STORAGE_PREFIX + encodeURIComponent(String(sessionId))
    }

    function parsePendingQuotes(raw) {
      if (typeof raw !== 'string' || raw === '') return []
      try {
        var value = JSON.parse(raw)
        if (!Array.isArray(value)) return []
        return value.filter(function (q) {
          return q !== null && typeof q === 'object'
            && typeof q.id === 'string' && typeof q.text === 'string' && q.text !== ''
        }).map(function (q) {
          return {
            id: q.id,
            text: q.text,
            note: typeof q.note === 'string' ? q.note : '',
            ...(typeof q.sourceUrl === 'string' && typeof q.sourcePath === 'string'
              ? { sourceUrl: q.sourceUrl, sourcePath: q.sourcePath } : {}),
            range: null,
            seqKey: typeof q.seqKey === 'string' ? q.seqKey : '',
            rowHead: typeof q.rowHead === 'string' ? q.rowHead : '',
            textOffset: Number.isFinite(q.textOffset) ? q.textOffset : -1,
            ctxBefore: typeof q.ctxBefore === 'string' ? q.ctxBefore : '',
            ctxAfter: typeof q.ctxAfter === 'string' ? q.ctxAfter : '',
          }
        })
      } catch (_) {
        return []
      }
    }

    function stringifyPendingQuotes(quotes) {
      return JSON.stringify(quotes.map(function (q) {
        return {
          id: q.id,
          text: q.text,
          note: q.note || '',
          ...(q.sourceUrl ? { sourceUrl: q.sourceUrl, sourcePath: q.sourcePath } : {}),
          seqKey: q.seqKey || '',
          rowHead: q.rowHead || '',
          textOffset: Number.isFinite(q.textOffset) ? q.textOffset : -1,
          ctxBefore: q.ctxBefore || '',
          ctxAfter: q.ctxAfter || '',
        }
      }))
    }

    // ============================== 插件主体 ==============================
    function apply(ctx) {
      var sessions = ctx.sessions
      try { console.log('[next-ui-diagnostic] ANNOT-PROBE apply() ran ' + Date.now()) } catch (_) { /* ignore */ }

      // ================= 配色工作室 + 批注大纲（本地升级 · X-WIDE · 2026-10-16）=================
      // 纯叠加层，不改原作者逻辑：① 注入带 !important 的样式覆盖 .dsh-ann-hl 写死黄色（底色取 --dshap-hl）；
      // ② 把全局 CSS 变量 --dsw-alias-text-accent 设为所选色 → 编号徽标/回复芯片强调色整体换色。
      // 右下角小圆点弹层：4 套荧光预设 + 自定义取色 + 恢复默认；Alt+Shift+C 循环；存 localStorage['dshap.color']。
      // 给"添加批注"卡片用的配色行构造器（由下面的 colorStudio 赋值；未就绪时为 null）
      var colorRowBuilder = null
      var colorStudio = (function () {
        var KEY = 'dshap.color'
        var STYLE_ID = 'dshap-color-style'
        // 幂等：apply() 可能被调用多次，先清掉上一轮遗留的圆点/面板，避免「每点一次多开一个」
        try {
          var _oldDot = document.getElementById('dshap-dot'); if (_oldDot !== null) _oldDot.remove()
          var _oldPanel = document.getElementById('dshap-panel'); if (_oldPanel !== null) _oldPanel.remove()
          var _oldLb = document.getElementById('dshap-list-btn'); if (_oldLb !== null) _oldLb.remove()
          var _oldLp = document.getElementById('dshap-list'); if (_oldLp !== null) _oldLp.remove()
        } catch (_) { /* ignore */ }
        var PRESETS = [
          { name: '荧光黄', hex: '#ffc300' },
          { name: '荧光绿', hex: '#2ecc71' },
          { name: '荧光青', hex: '#00c8ff' },
          { name: '荧光粉', hex: '#ff63c5' }
        ]
        function hexToRgba(hex, a) {
          var h = String(hex).replace('#', '')
          if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
          var n = parseInt(h, 16)
          if (isNaN(n)) return 'rgba(255,195,0,' + a + ')'
          var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
          return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'
        }
        function readColor() {
          try {
            var v = localStorage.getItem(KEY)
            if (typeof v === 'string' && /^#?[0-9a-fA-F]{6}$/.test(v)) {
              return v.charAt(0) === '#' ? v : '#' + v
            }
          } catch (_) { /* ignore */ }
          return null
        }
        function saveColor(hex) { try { localStorage.setItem(KEY, hex) } catch (_) { /* ignore */ } }
        // 自定义调色板：每次"选完颜色点确定"就往里加一块，持久化
        var CUSTOM_KEY = 'dshap.customs'
        function readCustoms() {
          try {
            var arr = JSON.parse(localStorage.getItem(CUSTOM_KEY))
            if (Array.isArray(arr)) {
              var out = []
              for (var i = 0; i < arr.length; i++) {
                if (typeof arr[i] === 'string' && /^#[0-9a-fA-F]{6}$/.test(arr[i]) && out.indexOf(arr[i]) === -1) out.push(arr[i])
              }
              return out
            }
          } catch (_) { /* ignore */ }
          return []
        }
        function saveCustoms(list) { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)) } catch (_) { /* ignore */ } }
        function addCustom(hex) {
          if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return
          var list = readCustoms()
          if (list.indexOf(hex) === -1) { list.push(hex); saveCustoms(list) }
          renderPanel()
        }
        function applyColor(hex) {
          try {
            // 只动我自己的变量，**不再劫持 DSH 的主题变量 `--dsw-alias-text-accent`**
            // （那会连整个界面的强调色一起改，太霸道、也容易被别处覆盖 → 表现就是"颜色丢了"）。
            document.documentElement.style.setProperty('--dshap-hl', hexToRgba(hex, 0.18))
            document.documentElement.style.setProperty('--dshap-accent', hex)
          } catch (_) { /* ignore */ }
        }
        function clearColor() {
          try {
            document.documentElement.style.removeProperty('--dshap-hl')
            document.documentElement.style.removeProperty('--dshap-accent')
            localStorage.removeItem(KEY)
            // 2026-10-16 修「取消自定义颜色之后，它没有变换到有用的颜色上」：
            // 只清全局笔色不够 —— 每条批注的颜色一经记录就**固化**在 dshap.itemColors 里
            // （见 colorForItem 的设计注释），所以必须一并忘掉，标记才会真的回落。
            try { localStorage.removeItem(ITEM_COLOR_KEY) } catch (_) { /* ignore */ }
          } catch (_) { /* ignore */ }
        }
        if (document.getElementById(STYLE_ID) === null) {
          var st = document.createElement('style')
          st.id = STYLE_ID
          st.textContent = '.dsh-ann-hl { background: var(--ann-hl, var(--dshap-hl, rgba(255,195,0,.15))) !important; }\n'
            // 关掉高亮块自带的那点淡入动画：插件每滚动一次就重建标记，
            // 新建的块会把动画重播一遍 → 看起来就是"框子慢半拍吸到位置上"。
            + '.dsh-ann-hl { animation: none !important; }\n'
            + '.dsh-ann-num { background: var(--dshap-accent, #4c9aff); color: #fff; }\n'
            // 稍微加宽"添加/编辑批注"卡片，好放下新加的配色行
            + '.dsh-ann-card { width: 470px !important; }\n'
            + '#dshap-panel a, #dshap-list a { color: #7cc4ff; text-decoration: underline; cursor: pointer; }'
            // 2026-10-16 用户：「界面里面那些字字号是改了，但是还是不明显，直接变成白的吧」——
            // 插件自己的界面（配色面板 / 大纲面板 / @ 引用清单 / 加批注卡片 / 提示框）文字一律纯白。
            // 这里**只加 CSS**，不碰任何逻辑；样式挂不上最多是颜色没变，绝不会影响插件启动。
            // 注意：**卡片里的按钮不能一起刷白** —— 「保存批注」是浅底按钮（宿主自己的
            // button-primary 配色），被 !important 刷成白字就成了白底白字、彻底看不见
            // （用户 2026-10-16 17:52 截图点名）。所以卡片改成白名单：
            //   只刷 标题 / 引文 / 输入框 / 颜色行标签 —— 按钮一律还给宿主配色。
            + '#dshap-panel, #dshap-panel *, #dshap-list, #dshap-list *, #dshap-mention, #dshap-mention *,'
            + ' .dsh-ann-tip, .dsh-ann-tip *, .dsh-ann-bar, .dsh-ann-bar *'
            + ' { color: #fff !important; }'
            + '.dsh-ann-card-title, .dsh-ann-quote, .dsh-ann-card textarea, .dsh-ann-card input,'
            + ' .dsh-ann-card .dshap-lbl { color: #fff !important; }'
            + '.dsh-ann-num { font-weight: 700; }'
          document.head.appendChild(st)
        }
        var saved = readColor()
        if (saved !== null) applyColor(saved)

        var dot = document.createElement('div')
        dot.id = 'dshap-dot'
        dot.title = '批注配色：点开选色 · 可拖动到任意位置 · Alt+Shift+C 切换预设'
        dot.textContent = '🎨'
        dot.style.cssText = 'display:flex;align-items:center;justify-content:center;'
          + 'position:fixed;right:18px;top:92px;width:48px;height:48px;'
          + 'border-radius:50%;z-index:2147483646;cursor:grab;border:3px solid #fff;'
          + 'box-shadow:0 4px 16px rgba(0,0,0,.55);background:' + (saved || '#ffc300') + ';'
          + 'color:#111;font-size:22px;line-height:1;user-select:none;touch-action:none;'
        try {
          var _pos = localStorage.getItem('dshap.pos.v2')
          if (typeof _pos === 'string') {
            var _p = JSON.parse(_pos)
            if (_p !== null && typeof _p.left === 'number' && typeof _p.top === 'number') {
              dot.style.left = _p.left + 'px'
              dot.style.top = _p.top + 'px'
              dot.style.right = 'auto'
              dot.style.bottom = 'auto'
            }
          }
        } catch (_) { /* ignore */ }
        document.body.appendChild(dot)

        // ---------- 批注大纲列表（Obsidian 式：列全部标记，点一条跳过去）----------
        var INDEX_COLORS = ['#ffc300', '#ff4444', '#2ecc71', '#00c8ff', '#ff63c5', '#b06bff', '#ff9800', '#00d4a0']
        function colorForIndex(i) { return INDEX_COLORS[i % INDEX_COLORS.length] }

        var listBtn = document.createElement('div')
        listBtn.id = 'dshap-list-btn'
        listBtn.title = '批注大纲：点一条跳到该标记位置'
        listBtn.textContent = '📋'
        listBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;'
          + 'position:fixed;right:18px;top:148px;width:48px;height:48px;'
          + 'border-radius:50%;z-index:2147483646;cursor:pointer;border:3px solid #fff;'
          + 'box-shadow:0 4px 16px rgba(0,0,0,.55);background:#333;'
          + 'color:#eee;font-size:20px;line-height:1;user-select:none;'
        document.body.appendChild(listBtn)

        var listPanel = document.createElement('div')
        listPanel.id = 'dshap-list'
        listPanel.style.cssText = 'display:none;position:fixed;right:18px;top:206px;z-index:2147483646;'
          + 'box-sizing:border-box;width:340px;max-height:60vh;overflow:auto;padding:10px;border-radius:12px;'
          + 'border:1px solid var(--dsw-alias-border-inverted,#444);'
          + 'background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-primary,#eee);'
          + 'font-family:var(--dsw-font-family,system-ui);font-size:12px;'
          + 'box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.4));'
        document.body.appendChild(listPanel)

        var panel = document.createElement('div')
        panel.id = 'dshap-panel'
        panel.style.cssText = 'display:none;position:fixed;z-index:2147483646;'
          + 'box-sizing:border-box;width:280px;padding:14px;border-radius:14px;'
          + 'border:1px solid var(--dsw-alias-border-inverted,#444);'
          + 'background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-primary,#eee);'
          + 'font-family:var(--dsw-font-family,system-ui);font-size:13px;'
          + 'box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.4));'
        document.body.appendChild(panel)

        // ---------- 自定义取色盘（自带「确定 / 取消」）----------
        // 起因（用户 2026-10-16 原话）：「调色时现在是点非调色界面的地方来确认调色，
        // 不如直接给个明确的确认按钮」。原实现用原生 <input type="color"> —— 那个盘
        // 没有确定键，只能点别处关闭，所以换成本地自绘的 HSV 盘 + 明确的按钮。
        var pickerOpen = false
        var pkH = 300, pkS = 0.55, pkV = 1, pkSeed = '#ffc300'
        function pkClamp(n, a, b) { return n < a ? a : (n > b ? b : n) }
        function pkRgb(hex) {
          var h = String(hex).replace('#', '')
          if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
          var n = parseInt(h, 16)
          if (isNaN(n)) return [255, 195, 0]
          return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
        }
        function pkHexFromHsv(h, s, v) {
          var c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c
          var r = 0, g = 0, b = 0
          if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
          else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
          else if (h < 300) { r = x; b = c } else { r = c; b = x }
          function q(n) { var t = Math.round((n + m) * 255); if (t < 0) t = 0; if (t > 255) t = 255; return (t < 16 ? '0' : '') + t.toString(16) }
          return '#' + q(r) + q(g) + q(b)
        }
        function pkHsvFromHex(hex) {
          var c = pkRgb(hex)
          var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255
          var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0
          if (d !== 0) {
            if (mx === r) h = 60 * (((g - b) / d) % 6)
            else if (mx === g) h = 60 * ((b - r) / d + 2)
            else h = 60 * ((r - g) / d + 4)
          }
          if (h < 0) h += 360
          return [h, mx === 0 ? 0 : d / mx, mx]
        }
        function resetPickerSeed(cur) {
          var seed = (typeof cur === 'string' && /^#[0-9a-fA-F]{6}$/.test(cur)) ? cur : (pkSeed || '#ffc300')
          pkSeed = seed
          var s = pkHsvFromHex(seed)
          pkH = s[0]; pkS = s[1]; pkV = s[2]
        }
        function renderPicker(host, onOk, onCancel) {
          var wrap = document.createElement('div')
          wrap.style.cssText = 'margin:4px 0 12px;padding:10px;border-radius:10px;'
            + 'border:1px solid var(--dsw-alias-border-inverted,#444);background:rgba(127,127,127,.10);'
          // 用户 2026-10-16：「到底是什么，让人能看得清」——先把这盘怎么用写出来。
          var hint = document.createElement('div')
          hint.textContent = '拖动选色 · 也可直接敲 16 进制 · 选完点「确定」'
          hint.style.cssText = 'font-size:12px;line-height:1.5;opacity:.85;margin-bottom:9px;'
          wrap.appendChild(hint)
          var sv = document.createElement('div')
          var hue = document.createElement('div')
          var svDot = document.createElement('div')
          var hueDot = document.createElement('div')
          var chip = document.createElement('div')
          var hexIn = document.createElement('input')
          var rgb = document.createElement('div')
          sv.style.cssText = 'position:relative;height:118px;border-radius:9px;cursor:crosshair;touch-action:none;'
            + 'border:1px solid var(--dsw-alias-border-inverted,#444);'
          hue.style.cssText = 'position:relative;height:18px;margin-top:10px;border-radius:9px;cursor:pointer;touch-action:none;'
            + 'border:1px solid var(--dsw-alias-border-inverted,#444);'
            + 'background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00);'
          svDot.style.cssText = 'position:absolute;width:14px;height:14px;border-radius:50%;border:2px solid #fff;'
            + 'box-shadow:0 0 2px rgba(0,0,0,.85);pointer-events:none;transform:translate(-50%,-50%);'
          hueDot.style.cssText = svDot.style.cssText
          chip.style.cssText = 'width:32px;height:32px;border-radius:8px;flex:0 0 auto;'
            + 'border:1px solid rgba(127,127,127,.45);'
          hexIn.type = 'text'
          hexIn.spellcheck = false
          hexIn.title = '也可以直接敲 16 进制色值，例如 #ff63c5'
          hexIn.style.cssText = 'width:auto;flex:1 1 auto;min-width:0;padding:7px 9px;border-radius:8px;font-size:13px;font-weight:600;'
            + 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;'
            + 'border:1px solid var(--dsw-alias-border-inverted,#444);background:transparent;color:inherit;'
          // 原来 flex:1 1 auto + 10px，在 224px 面板里被挤成「21 G194 B180」（截图里被切掉）。
          // 改成不收缩 + 12px，面板同时加宽到 280px。
          rgb.style.cssText = 'font-size:12px;opacity:.9;flex:0 0 auto;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;'
          function curHex() { return pkHexFromHsv(pkH, pkS, pkV) }
          function paint(keepInput) {
            var hx = curHex()
            sv.style.background = 'linear-gradient(to top,#000,rgba(0,0,0,0)),'
              + 'linear-gradient(to right,#fff,hsl(' + Math.round(pkH) + ',100%,50%))'
            svDot.style.left = (pkS * 100) + '%'
            svDot.style.top = ((1 - pkV) * 100) + '%'
            hueDot.style.left = ((pkH / 360) * 100) + '%'
            chip.style.background = hx
            if (keepInput !== true) hexIn.value = hx
            var c = pkRgb(hx)
            rgb.textContent = 'R' + c[0] + ' G' + c[1] + ' B' + c[2]
          }
          function dragOn(el, apply) {
            el.addEventListener('pointerdown', function (e) {
              e.stopPropagation(); e.preventDefault()
              try { el.setPointerCapture(e.pointerId) } catch (_) { /* ignore */ }
              apply(e)
              el.addEventListener('pointermove', apply)
              el.addEventListener('pointerup', function up(ev) {
                try { el.releasePointerCapture(ev.pointerId) } catch (_) { /* ignore */ }
                el.removeEventListener('pointermove', apply)
                el.removeEventListener('pointerup', up)
              })
            })
          }
          dragOn(sv, function (e) {
            var r = sv.getBoundingClientRect()
            pkS = pkClamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1)
            pkV = 1 - pkClamp((e.clientY - r.top) / Math.max(1, r.height), 0, 1)
            paint()
          })
          dragOn(hue, function (e) {
            var r = hue.getBoundingClientRect()
            pkH = pkClamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1) * 360
            paint()
          })
          hexIn.addEventListener('input', function () {
            var v = String(hexIn.value || '').trim()
            if (!/^#?[0-9a-fA-F]{6}$/.test(v)) return
            var s = pkHsvFromHex(v.charAt(0) === '#' ? v : '#' + v)
            pkH = s[0]; pkS = s[1]; pkV = s[2]
            paint(true)
          })
          hexIn.addEventListener('blur', function () { hexIn.value = curHex() })
          sv.appendChild(svDot)
          hue.appendChild(hueDot)
          wrap.appendChild(sv)
          wrap.appendChild(hue)
          var line = document.createElement('div')
          line.style.cssText = 'display:flex;align-items:center;gap:9px;margin-top:10px;'
          line.appendChild(chip); line.appendChild(hexIn); line.appendChild(rgb)
          wrap.appendChild(line)
          var btns = document.createElement('div')
          btns.style.cssText = 'display:flex;gap:9px;margin-top:10px;'
          var noBtn = document.createElement('button')
          noBtn.textContent = '取消'
          noBtn.style.cssText = 'flex:1 1 0;padding:9px 10px;border-radius:9px;cursor:pointer;font-size:13px;'
            + 'border:1px solid var(--dsw-alias-border-inverted,#444);background:transparent;color:inherit;'
          var okBtn = document.createElement('button')
          okBtn.textContent = '确定'
          okBtn.style.cssText = 'flex:1 1 0;padding:9px 10px;border-radius:9px;cursor:pointer;font-size:13px;'
            + 'font-weight:600;border:1px solid #3b82f6;background:#3b82f6;color:#fff;'
          // 「确定 / 取消」由调用方决定：🎨 面板走 set()+addCustom()；
          // 批注卡片里的配色行走 bindToCard()（把颜色记到那一条批注身上）。
          okBtn.addEventListener('click', function (e) {
            e.stopPropagation()
            if (typeof onOk === 'function') onOk(curHex())
          })
          noBtn.addEventListener('click', function (e) {
            e.stopPropagation()
            if (typeof onCancel === 'function') onCancel()
          })
          btns.appendChild(noBtn); btns.appendChild(okBtn)
          wrap.appendChild(btns)
          host.appendChild(wrap)
          paint()
        }
        function renderPanel() {
          panel.innerHTML = ''
          var head = document.createElement('div')
          head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;'
          var title = document.createElement('div')
          title.textContent = '批注配色'
          title.style.cssText = 'font-weight:600;font-size:15px;'
          head.appendChild(title)
          var closeBtn = document.createElement('div')
          closeBtn.textContent = '✕'
          closeBtn.title = '关闭 (Esc)'
          closeBtn.style.cssText = 'cursor:pointer;padding:0 4px;font-size:14px;line-height:1;'
            + 'color:var(--dsw-alias-label-secondary,#aaa);'
          closeBtn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(false) })
          head.appendChild(closeBtn)
          panel.appendChild(head)
          var row = document.createElement('div')
          row.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;'
          PRESETS.forEach(function (p) {
            var sw = document.createElement('div')
            sw.title = p.name
            sw.style.cssText = 'width:32px;height:32px;border-radius:9px;cursor:pointer;'
              + 'border:2px solid ' + (readColor() === p.hex ? '#fff' : 'transparent') + ';'
              + 'background:' + p.hex + ';'
            sw.addEventListener('click', function () { set(p.hex) })
            row.appendChild(sw)
          })
          panel.appendChild(row)
          var cur0 = readColor()
          var isPreset = false
          for (var pi = 0; pi < PRESETS.length; pi++) { if (PRESETS[pi].hex === cur0) { isPreset = true; break } }
          var customWrap = document.createElement('div')
          customWrap.title = '自定义颜色：点开取色盘，选完点「确定」'
          customWrap.style.cssText = 'position:relative;width:32px;height:32px;border-radius:9px;cursor:pointer;'
            + 'border:2px solid ' + (cur0 !== null && !isPreset ? '#fff' : 'transparent') + ';'
            + 'background:conic-gradient(#ff4444,#ffc300,#2ecc71,#00c8ff,#b06bff,#ff4444);'
          customWrap.addEventListener('click', function (e) {
            e.stopPropagation()
            pickerOpen = !pickerOpen
            if (pickerOpen) resetPickerSeed(cur0)
            renderPanel()
          })
          row.appendChild(customWrap)
          panel.appendChild(row)
          // 取色盘（自带「确定 / 取消」）。只有点过彩虹色块才展开，
          // 展开时把当前色作为起点，取消 = 什么都不改。
          if (pickerOpen) {
            renderPicker(panel, function (hx) {
              pickerOpen = false
              set(hx)         // 上色 + 存 localStorage + 立刻刷标记 + 重建面板
              addCustom(hx)   // 加进「我的颜色」
            }, function () {
              pickerOpen = false
              renderPanel()
            })
          }
          // 简化：去掉「统一色 / 按编号分色」开关。
          // 现在就是一句话：每条批注记自己的颜色；没记过的回落编号色表（1、2、3…）。
          var customs = readCustoms()
          if (customs.length > 0) {
            var clbl = document.createElement('div')
            clbl.textContent = '我的颜色（右键删除）'
            clbl.style.cssText = 'font-size:12px;opacity:.8;margin:0 0 8px;'
            panel.appendChild(clbl)
            var crow = document.createElement('div')
            crow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;'
            customs.forEach(function (hex) {
              var cb = document.createElement('div')
              cb.title = hex
              cb.style.cssText = 'width:32px;height:32px;border-radius:9px;cursor:pointer;'
                + 'border:2px solid ' + (readColor() === hex ? '#fff' : 'transparent') + ';background:' + hex + ';'
              cb.addEventListener('click', function () { set(hex) })
              cb.addEventListener('contextmenu', function (e) {
                e.preventDefault()
                var list = readCustoms()
                var idx = list.indexOf(hex)
                if (idx !== -1) { list.splice(idx, 1); saveCustoms(list) }
                renderPanel()
              })
              crow.appendChild(cb)
            })
            panel.appendChild(crow)
          }
          var reset = document.createElement('button')
          reset.textContent = '恢复默认'
          reset.style.cssText = 'margin-top:10px;width:100%;padding:5px 8px;border-radius:7px;cursor:pointer;'
            + 'border:1px solid var(--dsw-alias-border-inverted,#444);background:transparent;'
            + 'color:var(--dsw-alias-label-secondary,#aaa);font-size:12px;'
          // 「恢复默认」= 清掉长期驻留的自定义色 → 立刻回落到编号色表（1 黄 2 红 3 绿…）
          reset.addEventListener('click', function () {
            clearColor()
            dot.style.background = '#ffc300'
            _lastColor = '\u0000force'   // 逼下一次比对必定重刷
            applyMarkerState()
            renderPanel()
          })
          panel.appendChild(reset)
          var foot = document.createElement('div')
          foot.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(127,127,127,.25);font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#999);'
          foot.innerHTML = 'dsh-xwide-annotation <b>v1.5.0</b> · 2026-10-17<br>'
            + '原作者：<a href="https://github.com/omdsh-dev/dsh-annotation" target="_blank" rel="noreferrer">omdsh-dev · dsh-annotation v1.4.11（MIT）</a>'
            + ' · 发布页：<a href="https://github.com/XWIDE/dsh-xwide-annotation" target="_blank" rel="noreferrer">github.com/XWIDE/dsh-xwide-annotation</a><br>'
            + '<a href="https://github.com/XWIDE" target="_blank" rel="noreferrer"><b>X-WIDE</b></a> · '
            + '<a href="https://space.bilibili.com/374064919" target="_blank" rel="noreferrer">B 站 374064919</a> · '
            + '<a href="mailto:xiupk@sina.com.cn">xiupk@sina.com.cn</a>'
          panel.appendChild(foot)
        }
        // 选色后**立即上色**（含正文编号牌）。必须显式调 applyMarkerState()：
        // 编号牌的颜色是 inline 写在元素上的，不显式刷就要等下一次自动刷新（最多 2.5s），
        // 表现就是"在标注卡片里点了颜色却没反应"。
        function set(hex) {
          applyColor(hex)
          saveColor(hex)
          dot.style.background = hex
          _lastColor = '\u0000force'
          try { applyMarkerState() } catch (_) { /* ignore */ }
          renderPanel()
        }
        function cycle() {
          var cur = readColor()
          var idx = -1
          for (var i = 0; i < PRESETS.length; i++) { if (PRESETS[i].hex === cur) { idx = i; break } }
          set(PRESETS[(idx + 1) % PRESETS.length].hex)
        }
        var open = false
        /** 把浮层钳进视口——防止它跑到屏幕外（表现就是"只剩一条边、内容被切掉"）。 */
        function clampIntoView(el) {
          try {
            var r = el.getBoundingClientRect()
            var w = r.width, h = r.height
            var left = r.left, top = r.top
            if (w > 0 && left + w > window.innerWidth - 8) left = window.innerWidth - w - 8
            if (left < 8) left = 8
            if (h > 0 && top + h > window.innerHeight - 8) top = window.innerHeight - h - 8
            if (top < 8) top = 8
            el.style.left = Math.round(left) + 'px'
            el.style.top = Math.round(top) + 'px'
            el.style.right = 'auto'
            el.style.bottom = 'auto'
          } catch (_) { /* ignore */ }
        }
        function setOpen(v) {
          open = v
          pickerOpen = false   // 面板开/关都收起取色盘，避免"上次没点确定"的状态残留
          if (open) {
            renderPanel()
            // 固定停靠：面板永远出现在「圆钮下方、贴右边缘」——不跟着圆钮/鼠标飘，位置可预期。
            panel.style.right = '18px'
            panel.style.left = 'auto'
            panel.style.top = '148px'
            panel.style.bottom = 'auto'
            panel.style.display = 'block'
            clampIntoView(panel)
          } else { panel.style.display = 'none' }
        }
        function placePanel() {
          var r = dot.getBoundingClientRect()
          var pw = 224
          var left = Math.round(Math.min(Math.max(8, r.left + 48 + 10), window.innerWidth - pw - 8))
          if (left < 8) left = Math.round(Math.min(Math.max(8, r.left - pw - 10), window.innerWidth - pw - 8))
          var top = Math.round(Math.min(Math.max(8, r.top - 40), Math.max(8, window.innerHeight - 300)))
          panel.style.left = left + 'px'
          panel.style.top = top + 'px'
        }
        var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0
        dot.addEventListener('pointerdown', function (e) {
          dragging = true; moved = false
          var r = dot.getBoundingClientRect()
          sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top
          dot.style.cursor = 'grabbing'
          try { dot.setPointerCapture(e.pointerId) } catch (_) { /* ignore */ }
          e.preventDefault()
        })
        dot.addEventListener('pointermove', function (e) {
          if (!dragging) return
          var dx = e.clientX - sx, dy = e.clientY - sy
          if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) moved = true
          if (!moved) return
          var nl = Math.max(0, Math.min(ox + dx, window.innerWidth - 48))
          var nt = Math.max(0, Math.min(oy + dy, window.innerHeight - 48))
          dot.style.left = nl + 'px'; dot.style.top = nt + 'px'
          dot.style.right = 'auto'; dot.style.bottom = 'auto'
          // 注意：拖动圆钮时**不再带着面板跑** —— 面板是固定停靠的，跟着动就会"飘"。
        })
        dot.addEventListener('pointerup', function (e) {
          if (!dragging) return
          dragging = false
          dot.style.cursor = 'grab'
          try { dot.releasePointerCapture(e.pointerId) } catch (_) { /* ignore */ }
          if (moved) {
            var r = dot.getBoundingClientRect()
            try { localStorage.setItem('dshap.pos.v2', JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) })) } catch (_) { /* ignore */ }
          } else {
            setOpen(!open)
          }
        })
        // 点面板/圆点之外的地方 → 自动关闭
        function onDocDown(e) {
          if (!open) return
          var t = e.target
          if (t === dot || dot.contains(t) || t === panel || panel.contains(t)) return
          setOpen(false)
        }
        function onKey(e) {
          if (e.key === 'Escape' && open) { setOpen(false); return }
          if (e.altKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) { cycle(); e.preventDefault() }
        }
        document.addEventListener('pointerdown', onDocDown, true)
        document.addEventListener('keydown', onKey, true)

        // ---------- 批注大纲：收集 / 跳转 / 编号上色 ----------
        // ---------- 大纲里的增删改（本地层）----------
        var HIDE_KEY = 'dshap.hidden'
        // 2026-10-17 ⑪：隐藏表**按会话分桶**（原先是全局一张表、键只是原文），
        // 于是「一键清空全部」在 A 对话里点一下，B 对话里同文的批注也一起没了。
        // 现在写成 dshap.hidden.<sessionId>；读写全部走 hideKey()，老键只读不写（留作兼容）。
        var HIDE_KEY_LEGACY = HIDE_KEY
        function hideKey() {
          try {
            var sid = (typeof readCurrentSessionId === 'function') ? String(readCurrentSessionId() || '') : ''
            if (sid === '') return HIDE_KEY_LEGACY + '.unknown'
            return HIDE_KEY_LEGACY + '.' + sid
          } catch (_) { return HIDE_KEY_LEGACY + '.unknown' }
        }
        var NOTE_KEY = 'dshap.notes'
        function readMap(key) {
          try {
            var o = JSON.parse(localStorage.getItem(key))
            return (o !== null && typeof o === 'object') ? o : {}
          } catch (_) { return {} }
        }
        function writeMap(key, o) { try { localStorage.setItem(key, JSON.stringify(o)) } catch (_) { /* ignore */ } }
        function keyOf(item) { return item.pending ? ('P|' + String(item.id)) : ('S|' + String(item.text)) }
        function collectAnnotations() {
          var out = []
          // ① 插件自己的全量批注清单：会话重开后，气泡上不一定还挂着 __annotationItems，
          //    这时只有这份是可靠的。它与下面的气泡来源按"原文"去重，不会重复。
          try {
            for (var u0 = 0; u0 < ui.quotes.length; u0++) {
              var q0 = ui.quotes[u0]
              var t0 = String((q0 && q0.text) || '')
              if (t0 === '') continue
              out.push({ text: t0, note: String((q0 && q0.note) || ''), pending: false })
            }
          } catch (_) { /* ignore */ }
          // ② 再从用户气泡标签上补一遍
          try {
            var tags = document.querySelectorAll('[data-annotation-bubble-tag]')
            for (var i = 0; i < tags.length; i++) {
              var items = tags[i].__annotationItems
              if (!Array.isArray(items)) continue
              for (var k = 0; k < items.length; k++) {
                var it = items[k]
                out.push({ text: String((it && it.text) || ''), note: String((it && it.note) || ''), pending: false })
              }
            }
          } catch (_) { /* ignore */ }
          // 原始编号：跟插件在正文里画的编号对齐（用插件自己的 ui.quotes 顺序做映射，
          // 找不到就退回"未过滤列表里的位置"）。删除后**保留空号**（1、3、4），不重排。
          var idxMap = {}
          try {
            var idList = markerListFor()
            for (var u = 0; u < idList.length; u++) {
              var qt = String((idList[u] && idList[u].text) || '')
              if (qt !== '' && idxMap[qt] === undefined) idxMap[qt] = u + 1
            }
          } catch (_) { /* ignore */ }
          // 过滤"本地删掉"的 + 套用"本地改过"的批注文字
          var hidden = readMap(hideKey())
          var notes = readMap(NOTE_KEY)
          var res = []
          var seen = {}
          for (var j = 0; j < out.length; j++) {
            var key = keyOf(out[j])
            if (hidden[key] === 1) continue
            if (seen[key] === 1) continue
            seen[key] = 1
            out[j].idx = (idxMap[out[j].text] !== undefined) ? idxMap[out[j].text] : (j + 1)
            if (typeof notes[key] === 'string') out[j].note = notes[key]
            res.push(out[j])
          }
          return res
        }
        var editingItem = null
        function editItem(it) { editingItem = it; listSig = ''; renderList() }
        function saveNote(it, next) {
          if (typeof next !== 'string') return
          if (it.pending) {
            try {
              for (var i = 0; i < ui.quotes.length; i++) {
                if (ui.quotes[i].id === it.id) { ui.quotes[i].note = next; break }
              }
              writePendingQuotes(readCurrentSessionId())
              updateChip()
              renderMarkers()
            } catch (_) { /* ignore */ }
          } else {
            var notes = readMap(NOTE_KEY)
            notes[keyOf(it)] = next
            writeMap(NOTE_KEY, notes)
          }
          editingItem = null
          listSig = ''
          renderList()
        }
        function removeItem(it) {
          if (it.pending) {
            try {
              removeQuote(it.id)
              writePendingQuotes(readCurrentSessionId())
              updateChip()
              renderMarkers()
            } catch (_) { /* ignore */ }
          } else {
            var hidden = readMap(hideKey())
            hidden[keyOf(it)] = 1
            writeMap(hideKey(), hidden)
          }
          listSig = ''
          renderList()
        }
        var confirmClear = false
        function clearAllItems(items) {
          var hidden = readMap(hideKey())
          // ① 大纲里现有的每一条都记进"隐藏表"（刷新后也不复活）
          for (var i = 0; i < items.length; i++) hidden[keyOf(items[i])] = 1
          // ② 再把插件自己的全量清单（ui.quotes）也一并记上 —— 保证"一条不剩"
          try {
            for (var u = 0; u < ui.quotes.length; u++) {
              var t = String((ui.quotes[u] && ui.quotes[u].text) || '')
              if (t !== '') hidden['S|' + t] = 1
            }
          } catch (_) { /* ignore */ }
          writeMap(hideKey(), hidden)
          // ③ 顺带清空插件的"待发送"队列（输入框边上的「批注 ×N」标签）
          try {
            ui.quotes = []
            writePendingQuotes(readCurrentSessionId())
            updateChip()
            renderMarkers()
          } catch (_) { /* ignore */ }
        }
        // 2026-10-16 整段删除（用户要求）：「点大纲视图里切换位置时，会出一个色彩的框，
        // 然后逐渐消失，这个效果不要」。原 flashRow() 会在目标消息外面画一个 3px 彩色描边
        // + 同色光晕，2.2 秒后开始淡出、2.9 秒删掉 —— 正是那个"闪一下就没"的框。
        // 跳转本身（scrollIntoView 滚到该条）保留；"到哪儿了"改由正文已有的黄底 / 编号承担。
        function candidateRows() {
          // 只搜「助手行」：批注的原文来自助手回复，标记也长在那儿；
          // 搜全部行会先命中用户气泡里的同一串文字 → 跳过去自然没有标记。
          try {
            var a = assistantRows()
            if (a !== null && a !== undefined && a.length > 0) return a
          } catch (_) { /* ignore */ }
          try {
            var m = allMessageRows()
            if (m !== null && m !== undefined && m.length > 0) return m
          } catch (_) { /* ignore */ }
          return document.querySelectorAll('[data-chat-flow-kind="assistant-step"], [data-time-hover-root], [class*="assistant"]')
        }
        function jumpTo(text, color) {
          var raw = String(text || '').trim()
          if (raw.length < 2) return false
          var needle = raw.replace(/\s+/g, ' ').slice(0, 40)
          var compact = raw.replace(/\s+/g, '')
          var rows = candidateRows()
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i]
            var tc = String(row.textContent || '')
            var hit = tc.indexOf(raw) !== -1 || tc.replace(/\s+/g, ' ').indexOf(needle) !== -1
            if (!hit && compact.length >= 4) hit = tc.replace(/\s+/g, '').indexOf(compact) !== -1
            if (hit) {
              try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch (_) { try { row.scrollIntoView() } catch (e2) { /* ignore */ } }
              return true
            }
          }
          return false
        }
        /** 找不到时：可能是老消息还没挂载 → 逐屏向上滚，边滚边找。 */
        function jumpToScrolling(text, color) {
          if (jumpTo(text, color)) return 'found'
          var sc = null
          try { sc = document.querySelector('[data-conversation-scroll]') } catch (_) { /* ignore */ }
          if (sc === null) { try { sc = document.querySelector('[data-chat-flow]') } catch (_) { /* ignore */ } }
          if (sc === null) return 'missing'
          var steps = 0
          var timer = setInterval(function () {
            sc.scrollTop = Math.max(0, sc.scrollTop - Math.max(240, sc.clientHeight * 0.9))
            if (jumpTo(text, color)) { clearInterval(timer); return }
            if (sc.scrollTop === 0 || ++steps > 30) { clearInterval(timer) }
          }, 180)
          return 'searching'
        }
        /** 被"大纲里删掉"的批注，对应插件标记的原始编号集合。 */
        function hiddenIndexSet() {
          var hidden = readMap(hideKey())
          var set = {}
          try {
            var list = markerListFor()
            for (var i = 0; i < list.length; i++) {
              var t = String((list[i] && list[i].text) || '')
              if (hidden['S|' + t] === 1) set[String(i + 1)] = 1
            }
          } catch (_) { /* ignore */ }
          return set
        }
        /** ① 按编号给徽标上色；② 把"已从大纲删除"的编号/高亮整条藏掉（只藏标记，不动正文）。 */
        function currentColorHex() { return readColor() || '#ffc300' }
        function colorMode() {
          try {
            var m = localStorage.getItem('dshap.mode')
            return (m === 'uni' || m === 'idx') ? m : 'idx'
          } catch (_) { return 'idx' }
        }
        var _lastColor = ''
        var _lastMode = ''
        var markerObserver = null
        /** 插件重画标记时才动手（childList 观察；我只改 style，不会再触发它 → 不会自激）。 */
        function ensureMarkerObserver() {
          if (markerObserver !== null) return
          try {
            var layers = []
            var o = document.querySelector('[data-annotation-overlay]')
            var n = document.querySelector('[data-annotation-num-layer]')
            if (o !== null) layers.push(o)
            if (n !== null) layers.push(n)
            if (layers.length === 0) return
            markerObserver = new MutationObserver(function () { applyMarkerState() })
            for (var i = 0; i < layers.length; i++) markerObserver.observe(layers[i], { childList: true })
          } catch (_) { markerObserver = null }
        }
        /** 每条批注**各记各的颜色**（存 localStorage['dshap.itemColors']，键 = 该条原文）。
         *  - 这条记录过颜色 → **永久用它**，后面在面板里再选别的颜色**不会**把它刷掉；
         *  - 没记录过 → 回落**编号色表**（1 黄 2 红 3 绿…）。
         *  🎨 里选色 = 给"接下来新建的那些批注"定色，不是全局重刷 —— 这条就是"颜色全同步"的根治。 */
        var ITEM_COLOR_KEY = 'dshap.itemColors'
        function colorForItem(text, idx) {
          var m = readMap(ITEM_COLOR_KEY)
          var v = m['S|' + String(text || '')]
          if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return v
          // 没记过颜色的（＝基线那版里被"全局色"统一刷着的老批注）回落到**当前笔色**，
          // 外观跟 12:45 那版完全一致，不会突然变成一条条彩虹。
          var pen = readColor()
          if (typeof pen === 'string') return pen
          // 2026-10-16：笔色被「恢复默认」清掉之后，回落到**编号色表**（1 黄 2 红 3 绿…），
          // 而不是让所有标记变成同一个颜色 —— 面板里那句「立刻回落到编号色表」终于兑现。
          var n = parseInt(idx, 10)
          return (n > 0) ? colorForIndex(n - 1) : '#ffc300'
        }
        function rememberItemColor(text, hex) {
          if (typeof text !== 'string' || text === '') return
          if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return
          var m = readMap(ITEM_COLOR_KEY)
          m['S|' + text] = hex
          writeMap(ITEM_COLOR_KEY, m)
        }
        function quoteTextAt(idxNum) {
          try {
            var list = markerListFor()
            if (idxNum > 0 && list[idxNum - 1]) return String(list[idxNum - 1].text || '')
          } catch (_) { /* ignore */ }
          return ''
        }
        /** 2026-10-16 修「标记过一会儿自己就不显示」①：高亮块的"看得见"下限。
         *  高亮只有 18% 不透明度，深色（例：#5b1541 深紫）在深色主题上等于**没画**。
         *  只把"当高亮用"的那一份色提到亮度下限（WCAG 相对亮度 ≥0.45），
         *  **不动**编号徽标的颜色 —— 你选的颜色仍然是你选的那个。 */
        function hlVisibleColor(hex) {
          try {
            if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex
            function ch2lin(x) { var v = parseInt(x, 16) / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
            function lumOf(h) { return 0.2126 * ch2lin(h.slice(1, 3)) + 0.7152 * ch2lin(h.slice(3, 5)) + 0.0722 * ch2lin(h.slice(5, 7)) }
            function mix(h, t) {
              var out = '#'
              for (var i = 1; i < 6; i += 2) {
                var v = parseInt(h.slice(i, i + 2), 16)
                var m = Math.round(v + (255 - v) * t)
                var s = m.toString(16)
                out += s.length === 1 ? '0' + s : s
              }
              return out
            }
            if (lumOf(hex) >= 0.45) return hex
            for (var t = 0.1; t <= 0.9001; t += 0.1) { var c = mix(hex, t); if (lumOf(c) >= 0.45) return c }
            return mix(hex, 0.9)
          } catch (_) { return hex }
        }

        function applyMarkerState() {
          try {
            var custom = readColor()
            var sig = String(custom)
            var marks = document.querySelectorAll('.dsh-ann-num, .dsh-ann-hl')
            // 效率优先：屏幕上没有标记、且当前笔色也没变 → 立刻返回
            if (marks.length === 0 && _lastColor === sig) return
            ensureMarkerObserver()
            // 写 CSS 自定义属性会触发整页样式重算 → 只在真的变了才写
            if (_lastColor !== sig) { applyColor(custom !== null ? custom : colorForIndex(0)); _lastColor = sig }
            var hid = hiddenIndexSet()
            var hiddenMap = readMap(hideKey())
            var itemMap = readMap(ITEM_COLOR_KEY)
            var itemDirty = false
            for (var i = 0; i < marks.length; i++) {
              var el = marks[i]
              var ix = el.getAttribute('data-ann-index')
              var idxNum = parseInt(ix || '0', 10)
              // 2026-10-16 修「标记过一会儿自己就不显示」②：隐藏**按原文**判定，不再只按下标。
              // 下标是建标记那一刻贴上的，切会话 / 重开 / 恢复正文标记之后清单会重排，
              // 下标与文字一旦错位，就会把**别人的**标记藏掉。文字才是稳定键（= dshap.hidden 的键）。
              var qtext = el.getAttribute('data-ann-text')
              if (qtext === null || qtext === '') qtext = quoteTextAt(idxNum)
              var isHidden = (qtext !== '' && hiddenMap['S|' + qtext] === 1)
              if (!isHidden && qtext === '' && ix !== null && hid[ix] === 1) isHidden = true   // 兜底：没有文字可依据时才用下标
              if (isHidden) { el.style.display = 'none'; continue }
              if (el.style.display === 'none') el.style.display = ''
              var col = colorForItem(qtext, idxNum)
              // 老批注第一次上色时，把颜色**固化**到这条身上；
              // 之后再改笔色只影响新批注，不会回头把这些刷掉 —— 这就是"只改当前这一条"。
              if (qtext !== '' && itemMap['S|' + qtext] === undefined) { itemMap['S|' + qtext] = col; itemDirty = true }
              if (el.className === 'dsh-ann-num') {
                el.style.background = col
                el.style.color = '#fff'
              } else {
                // 高亮块用**每元素一个变量**：样式表里那条规则带 !important，
                // 直接写 inline background 会被它压掉 → 用 --ann-hl 才能逐条变色。
                // 2026-10-16 修「标记看不见」：先提到亮度下限，再算 18% 的高亮色（编号徽标仍用 col 原色）
                var rgba = hexToRgba(hlVisibleColor(col), 0.18)
                el.style.setProperty('--ann-hl', rgba)
                el.style.background = rgba
              }
            }
            if (itemDirty) writeMap(ITEM_COLOR_KEY, itemMap)
          } catch (_) { /* ignore */ }
        }
        var listOpen = false
        var listTimer = null
        var listSig = ''
        function listSignature() {
          var items = collectAnnotations()
          var s = String(items.length)
          for (var i = 0; i < items.length; i++) s += '|' + items[i].text + ':' + items[i].note
          return s
        }
        function setListOpen(v) {
          listOpen = v
          if (listOpen) {
            applyMarkerState()
            listSig = listSignature()
            renderList()
            listPanel.style.display = 'block'
            clampIntoView(listPanel)
            if (listTimer === null) {
              listTimer = setInterval(function () {
                applyMarkerState()
                var sig = listSignature()
                if (sig !== listSig) { listSig = sig; renderList() }
              }, 1200)
            }
          } else {
            listPanel.style.display = 'none'
            if (listTimer !== null) { clearInterval(listTimer); listTimer = null }
          }
        }
        function renderList() {
          listPanel.innerHTML = ''
          var items = collectAnnotations()
          var head = document.createElement('div')
          head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-weight:600;'
          var ht = document.createElement('span')
          ht.textContent = '批注大纲（' + items.length + '）'
          head.appendChild(ht)
          var hb = document.createElement('div')
          hb.style.cssText = 'display:flex;align-items:center;gap:8px;'
          var clearAll = document.createElement('span')
          clearAll.textContent = '一键清空全部'
          clearAll.title = '清空这一对话里的全部批注（正文里的黄底与编号一起去掉）'
          clearAll.style.cssText = 'cursor:pointer;font-size:13px;font-weight:600;padding:5px 12px;border-radius:8px;'
            + 'border:1px solid rgba(255,90,90,.6);background:rgba(255,90,90,.18);'
          clearAll.addEventListener('click', function (e) { e.stopPropagation(); confirmClear = true; listSig = ''; renderList() })
          hb.appendChild(clearAll)
          var hidCount = 0
          try {
            var hmap = readMap(hideKey())
            for (var hk in hmap) { if (hmap[hk] === 1) hidCount++ }
          } catch (_) { /* ignore */ }
          if (hidCount > 0) {
            var restore = document.createElement('span')
            restore.textContent = '恢复已隐藏(' + hidCount + ')'
            restore.title = '把之前「删除/清空」掉的批注恢复显示（内容还在，只是被藏起来了）'
            restore.style.cssText = 'cursor:pointer;font-size:13px;font-weight:600;padding:5px 12px;border-radius:8px;'
              + 'border:1px solid rgba(120,200,120,.6);background:rgba(120,200,120,.18);'
            restore.addEventListener('click', function (e) {
              e.stopPropagation()
              writeMap(hideKey(), {})
              listSig = ''
              applyMarkerState()
              renderList()
            })
            hb.appendChild(restore)
          }
          var cb = document.createElement('span')
          cb.textContent = '✕'; cb.title = '关闭 (Esc)'
          cb.style.cssText = 'cursor:pointer;padding:0 6px;font-size:18px;line-height:1;color:var(--dsw-alias-label-secondary,#aaa);'
          cb.addEventListener('click', function (e) { e.stopPropagation(); setListOpen(false) })
          hb.appendChild(cb)
          head.appendChild(hb)
          listPanel.appendChild(head)
          if (confirmClear) {
            var warn = document.createElement('div')
            warn.style.cssText = 'margin:0 0 10px;padding:8px 10px;border-radius:8px;background:rgba(255,90,90,.16);'
              + 'border:1px solid rgba(255,90,90,.5);font-size:12px;line-height:1.5;'
            var wt = document.createElement('div')
            wt.textContent = '⚠️ 确定清空全部 ' + items.length + ' 条批注吗？清空后大纲里就不再显示，且不可撤销。'
            warn.appendChild(wt)
            var wb = document.createElement('div')
            wb.style.cssText = 'display:flex;gap:8px;margin-top:8px;'
            var yes = document.createElement('button')
            yes.textContent = '确定清空'
            yes.style.cssText = 'padding:5px 14px;border-radius:8px;cursor:pointer;font-size:13px;border:1px solid rgba(255,90,90,.7);background:rgba(255,90,90,.28);'
            yes.addEventListener('click', function (e) { e.stopPropagation(); clearAllItems(items); confirmClear = false; listSig = ''; renderList() })
            var no = document.createElement('button')
            no.textContent = '取消'
            no.style.cssText = 'padding:5px 14px;border-radius:8px;cursor:pointer;font-size:13px;'
            no.addEventListener('click', function (e) { e.stopPropagation(); confirmClear = false; listSig = ''; renderList() })
            wb.appendChild(yes); wb.appendChild(no)
            warn.appendChild(wb)
            listPanel.appendChild(warn)
          }
          if (editingItem !== null) {
            var ebar = document.createElement('div')
            ebar.style.cssText = 'display:flex;gap:6px;margin:0 0 8px;'
            var ei = document.createElement('input')
            ei.type = 'text'
            ei.value = editingItem.note
            ei.placeholder = '批注内容（回车保存，Esc 取消）'
            ei.style.cssText = 'flex:1 1 auto;min-width:0;padding:4px 6px;border-radius:6px;'
              + 'border:1px solid var(--dsw-alias-border-inverted,#444);background:transparent;color:inherit;font-size:12px;'
            var okb = document.createElement('button')
            okb.textContent = '保存'
            okb.style.cssText = 'padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;'
            var cxb = document.createElement('button')
            cxb.textContent = '取消'
            cxb.style.cssText = 'padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;'
            function _commitEdit() { saveNote(editingItem, ei.value) }
            okb.addEventListener('click', function (e) { e.stopPropagation(); _commitEdit() })
            cxb.addEventListener('click', function (e) { e.stopPropagation(); editingItem = null; listSig = ''; renderList() })
            ei.addEventListener('keydown', function (e) {
              e.stopPropagation()
              if (e.key === 'Enter') _commitEdit()
              else if (e.key === 'Escape') { editingItem = null; listSig = ''; renderList() }
            })
            ebar.appendChild(ei); ebar.appendChild(okb); ebar.appendChild(cxb)
            listPanel.appendChild(ebar)
            setTimeout(function () { try { ei.focus(); ei.select() } catch (_) { /* ignore */ } }, 0)
          }
          if (items.length === 0) {
            var empty = document.createElement('div')
            empty.textContent = '本对话暂无批注'
            empty.style.cssText = 'opacity:.6;padding:6px 0;'
            listPanel.appendChild(empty)
            return
          }
          for (var i = 0; i < items.length; i++) {
            (function (idx, it) {
              var rowEl = document.createElement('div')
              rowEl.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:6px;border-radius:8px;cursor:pointer;'
              rowEl.addEventListener('mouseenter', function () { rowEl.style.background = 'rgba(127,127,127,.18)' })
              rowEl.addEventListener('mouseleave', function () { rowEl.style.background = 'transparent' })
              var badgeNum = (it.idx !== undefined && it.idx > 0) ? it.idx : (idx + 1)
              var badge = document.createElement('span')
              badge.textContent = String(badgeNum)
              badge.style.cssText = 'flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;'
                + 'min-width:28px;height:28px;border-radius:14px;font-size:12px;font-weight:700;color:#111;'
                + 'background:' + colorForItem(it.text, badgeNum) + ';'
              rowEl.appendChild(badge)
              var body = document.createElement('div')
              body.style.cssText = 'flex:1 1 auto;min-width:0;'
              var t = document.createElement('div')
              t.textContent = it.text || '(无原文)'
              t.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
              body.appendChild(t)
              if (it.note) {
                var nt = document.createElement('div')
                nt.textContent = '批注：' + it.note
                nt.style.cssText = 'opacity:.7;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
                body.appendChild(nt)
              }
              rowEl.appendChild(body)
              if (it.pending) {
                var pt = document.createElement('span')
                pt.textContent = '未发送'
                pt.style.cssText = 'flex:0 0 auto;font-size:12px;opacity:.85;border:1px solid currentColor;border-radius:6px;padding:0 6px;'
                rowEl.appendChild(pt)
              }
              var acts = document.createElement('div')
              acts.style.cssText = 'flex:0 0 auto;display:flex;gap:8px;align-items:center;'
              var eb = document.createElement('span')
              eb.textContent = '✏'; eb.title = '改批注'
              eb.style.cssText = 'cursor:pointer;font-size:20px;line-height:1;padding:4px 8px;border-radius:8px;'
                + 'border:1px solid var(--dsw-alias-border-inverted,#444);background:rgba(127,127,127,.12);'
              eb.addEventListener('mouseenter', function () { eb.style.background = 'rgba(127,127,127,.28)' })
              eb.addEventListener('mouseleave', function () { eb.style.background = 'rgba(127,127,127,.12)' })
              eb.addEventListener('click', function (e) { e.stopPropagation(); editItem(it) })
              var db = document.createElement('span')
              db.textContent = '🗑'; db.title = '清除这条（本地隐藏，不改历史消息）'
              db.style.cssText = 'cursor:pointer;font-size:20px;line-height:1;padding:4px 8px;border-radius:8px;'
                + 'border:1px solid var(--dsw-alias-border-inverted,#444);background:rgba(127,127,127,.12);'
              db.addEventListener('mouseenter', function () { db.style.background = 'rgba(255,90,90,.28)' })
              db.addEventListener('mouseleave', function () { db.style.background = 'rgba(127,127,127,.12)' })
              db.addEventListener('click', function (e) { e.stopPropagation(); removeItem(it) })
              acts.appendChild(eb); acts.appendChild(db)
              rowEl.appendChild(acts)
              rowEl.addEventListener('click', function () {
                var old = listPanel.querySelector('.dshap-miss')
                if (old !== null) old.remove()
                var res = jumpToScrolling(it.text, colorForItem(it.text, badgeNum))
                if (res === 'missing') {
                  var miss = document.createElement('div')
                  miss.className = 'dshap-miss'
                  miss.textContent = '未找到该句（可能已滚出或被重排）'
                  miss.style.cssText = 'color:#ff8a8a;font-size:12px;margin-top:6px;'
                  listPanel.appendChild(miss)
                  setTimeout(function () { if (miss.parentNode !== null) miss.remove() }, 2500)
                }
              })
              listPanel.appendChild(rowEl)
            })(i, items[i])
          }
          var lf = document.createElement('div')
          lf.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid rgba(127,127,127,.25);font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#999);'
          lf.innerHTML = 'dsh-xwide-annotation <b>v1.5.0</b> · 2026-10-17<br>'
            + '原作者 <a href="https://github.com/omdsh-dev/dsh-annotation" target="_blank" rel="noreferrer">omdsh-dev（MIT）</a>'
            + ' · 发布页：<a href="https://github.com/XWIDE/dsh-xwide-annotation" target="_blank" rel="noreferrer">github.com/XWIDE/dsh-xwide-annotation</a><br>'
            + '升级 <a href="https://github.com/XWIDE" target="_blank" rel="noreferrer"><b>X-WIDE</b></a> · '
            + '<a href="https://space.bilibili.com/374064919" target="_blank" rel="noreferrer">B 站 374064919</a> · '
            + '<a href="mailto:xiupk@sina.com.cn">xiupk@sina.com.cn</a>'
          listPanel.appendChild(lf)
        }
        listBtn.addEventListener('click', function (e) { e.stopPropagation(); setListOpen(!listOpen) })
        function onKeyList(e) { if (e.key === 'Escape' && listOpen) setListOpen(false) }
        document.addEventListener('keydown', onKeyList, true)
        // 主触发 = MutationObserver（插件一重画就跟着上色/隐藏）；
        // 这个定时只当**兜底自愈**用：2.5s 一次，且**窗口不可见时直接跳过**，几乎不吃性能。
        var _lastFlowRows = -1
        var badgeTimer = setInterval(function () {
          if (document.hidden === true) return
          applyMarkerState()
          // 2026-10-16 修「过一会儿标记自己就不显示」③：宿主重排 DOM 会把标记层清空，
          // 而**没有任何东西**负责重画（切会话那条路已单独补过）。这里兜一次：
          // 清单里还有条目、屏幕上却一个标记都没有 → 立刻重画。
          try {
            if (document.querySelectorAll('.dsh-ann-hl, .dsh-ann-num').length === 0 && markerListFor().length > 0) {
              if (typeof scheduleMarkerRedraw === 'function') scheduleMarkerRedraw(120)
            }
          } catch (_) { /* ignore */ }
          // 2026-10-16 ⑤ 修用户点名的「只有出现在『加载更早』里的批注，在原文里不显示标记」：
          //   点「加载更早」是宿主把历史消息**插进**会话流 —— 那批行从没被扫过，
          //   挂在它们身上的批注条目就永远没登记进 restoredItems，原文自然画不出色块/编号。
          //   这里只盯一个廉价信号：会话流的行数。**只在行数变多的那一拍**重扫 + 重画
          //   （scheduleMarkerRedraw 会先跑 decorateAll 再强制重画），平时零成本。
          try {
            var flowRows = document.querySelectorAll('[data-chat-flow-kind], [data-time-hover-root]').length
            if (_lastFlowRows !== -1 && flowRows > _lastFlowRows) {
              if (typeof scheduleMarkerRedraw === 'function') scheduleMarkerRedraw(300)
            }
            _lastFlowRows = flowRows
          } catch (_) { /* ignore */ }
        }, 2500)

        // ---------- ⑧ 只读性能探针（2026-10-17 追加 · 纯新增；**不调用就一行都不跑**）----------
        // 目的：把用户报的「上下文多的时候，展开后的对话标注有点失效」变成**数字**——
        // 一次重画几毫秒、清单几条、定位成功几条、屏幕上画了几个。
        // 只测不改数据来源：唯一副作用是强制重画一次（这就是被测对象）。
        window.__dshapPerfTest = function () {
          var rep = { at: new Date().toISOString(), items: 0, located: 0 }
          try {
            var list = markerListFor()
            rep.items = list.length
            var t0 = Date.now()
            for (var i = 0; i < list.length; i++) { if (locateQuote(list[i].text, list[i])) rep.located++ }
            rep.msLocateAll = Date.now() - t0                       // N 条批注全定位一遍
            var t1 = Date.now()
            markersSig = null
            renderMarkers()
            rep.msDraw = Date.now() - t1                            // 一帧完整重画
            rep.domHl = document.querySelectorAll('.dsh-ann-hl').length
            rep.domNum = document.querySelectorAll('.dsh-ann-num').length
            rep.flowRows = document.querySelectorAll('[data-chat-flow-kind], [data-time-hover-root]').length
            rep.itemColors = (function () { try { return Object.keys(JSON.parse(localStorage.getItem('dshap.itemColors') || '{}')).length } catch (_) { return -1 } })()
            rep.hiddenKeys = (function () { try { return Object.keys(JSON.parse(localStorage.getItem('dshap.hidden') || '{}')).length } catch (_) { return -1 } })()
          } catch (e) { rep.error = String((e && e.message) ? e.message : e) }
          try { console.log('[__dshapPerfTest] ' + JSON.stringify(rep)) } catch (_) { /* ignore */ }
          return rep
        }

        // ---------- ⑨ 只读遥测（2026-10-17 追加 · 纯新增）：让 Agent 不用问用户就知道「线上跑的是哪版 + 标记真画出来几条」
        var DSHAP_BUILD = '20261017-1410-10c'   // ⑩ 行锚点 + ⑩b 偏移 + ⑩c 诊断
        window.__dshapBuild = DSHAP_BUILD
        window.__dshapTelemetry = function (why) {
          var s = { at: new Date().toISOString(), build: DSHAP_BUILD, why: String(why || '') }
          try {
            s.hl = document.querySelectorAll('.dsh-ann-hl').length
            s.num = document.querySelectorAll('.dsh-ann-num').length
            s.tags = document.querySelectorAll('[data-annotation-bubble-tag]').length
            s.rows = document.querySelectorAll('[data-chat-flow-kind], [data-time-hover-root]').length
            s.items = (typeof markerListFor === 'function') ? markerListFor().length : -1
            // ⑩c 诊断：只在「清单有、标记却是 0」时才算 —— 把每条为什么画不出来记下来
            // （rh=有 rowHead / sk=有 seqKey / rg=有 range / loc=locateQuote 成不成 / row=rowHead 能对上某行）
            try {
              if (s.items > 0 && s.hl === 0 && typeof markerListFor === 'function') {
                var _dl = markerListFor(), _dg = []
                var _rowsD = document.querySelectorAll('[data-chat-flow-kind], [data-time-hover-root]')
                for (var _i = 0; _i < _dl.length && _i < 6; _i++) {
                  var _q = _dl[_i]
                  var _d = { rh: _q.rowHead ? 1 : 0, sk: _q.seqKey ? 1 : 0, rg: _q.range ? 1 : 0, off: (_q.textOffset >= 0 ? _q.textOffset : -1) }
                  try { _d.loc = locateQuote(_q.text, _q) !== null ? 1 : 0 } catch (_e1) { _d.loc = -1 }
                  try {
                    if (_q.rowHead) {
                      for (var _j = 0; _j < _rowsD.length; _j++) {
                        if (String(_rowsD[_j].textContent || '').slice(0, 24) === _q.rowHead) { _d.row = 1; break }
                      }
                    }
                  } catch (_e2) { /* ignore */ }
                  _d.head = String(_q.rowHead || '').slice(0, 10)
                  _dg.push(_d)
                }
                s.diag = _dg
              }
            } catch (_eD) { s.diagErr = String((_eD && _eD.message) ? _eD.message : _eD) }
            var hist = []; try { hist = JSON.parse(localStorage.getItem('dshap.telemetry') || '[]') } catch (_) { hist = [] }
            if (!Array.isArray(hist)) hist = []; hist.push(s)
            while (hist.length > 24) hist.shift()
            localStorage.setItem('dshap.telemetry', JSON.stringify(hist))
          } catch (e) { s.error = String((e && e.message) ? e.message : e) }
          return s
        }
        var _telRows = -1, _telAt = 0
        window.__dshapTelTick = function () {   // 行数变了立刻采一行；否则 30 秒采一次（5 秒看一眼）
          try {
            var rows = document.querySelectorAll('[data-chat-flow-kind], [data-time-hover-root]').length
            var now = Date.now()
            if (rows !== _telRows) { _telRows = rows; _telAt = now; return window.__dshapTelemetry('rows') }
            if (now - _telAt > 30000) { _telAt = now; return window.__dshapTelemetry('beat') }
          } catch (_) { /* ignore */ }
          return null
        }
        if (typeof setInterval === 'function') setInterval(function () { window.__dshapTelTick() }, 5000)

        // ---------- 给"添加批注"卡片用的配色行（调色挪进标注面板）----------
        function buildColorRow() {
          var wrap = document.createElement('div')
          wrap.style.cssText = 'display:flex;align-items:center;gap:9px;margin-top:12px;flex-wrap:wrap;'
          // 关键：拦住 pointerdown，否则会被宿主判定为"点到了卡片外面"而把卡片关掉
          wrap.addEventListener('pointerdown', function (e) { e.stopPropagation() })
          wrap.addEventListener('click', function (e) { e.stopPropagation() })
          var lbl = document.createElement('span')
          lbl.className = 'dshap-lbl'
          lbl.textContent = '颜色'
          lbl.style.cssText = 'font-size:13px;opacity:.85;font-weight:600;'
          wrap.appendChild(lbl)
          var cur = readColor()
          function markOn(hex) {
            var all = wrap.querySelectorAll('[data-swatch]')
            for (var i = 0; i < all.length; i++) {
              all[i].style.borderColor = (all[i].getAttribute('data-swatch') === hex) ? '#fff' : 'transparent'
            }
          }
          /** 在卡片里选色 = 把颜色**记到这条批注身上**（新建就是 ui.quote；编辑就是那条的原文）。 */
          function bindToCard(hex) {
            set(hex)
            markOn(hex)
            try {
              var txt = ''
              if (ui !== undefined && ui !== null) {
                if (ui.editingId !== null && ui.editingId !== void 0) {
                  for (var qi = 0; qi < ui.quotes.length; qi++) {
                    if (ui.quotes[qi].id === ui.editingId) { txt = String(ui.quotes[qi].text || ''); break }
                  }
                } else {
                  txt = String(ui.quote || '')
                }
              }
              if (txt !== '') { rememberItemColor(txt, hex); applyMarkerState() }
            } catch (_) { /* ignore */ }
          }
          PRESETS.forEach(function (p) {
            var sw = document.createElement('div')
            sw.setAttribute('data-swatch', p.hex)
            sw.title = p.name
            sw.style.cssText = 'width:28px;height:28px;border-radius:8px;cursor:pointer;'
              + 'border:2px solid ' + (cur === p.hex ? '#fff' : 'transparent') + ';background:' + p.hex + ';'
            sw.addEventListener('click', function (ev) {
              ev.stopPropagation()
              bindToCard(p.hex)
            })
            wrap.appendChild(sw)
          })
          readCustoms().forEach(function (hex) {
            var cwb = document.createElement('div')
            cwb.setAttribute('data-swatch', hex)
            cwb.title = hex
            cwb.style.cssText = 'width:28px;height:28px;border-radius:8px;cursor:pointer;'
              + 'border:2px solid ' + (cur === hex ? '#fff' : 'transparent') + ';background:' + hex + ';'
            cwb.addEventListener('click', function (ev) { ev.stopPropagation(); bindToCard(hex) })
            wrap.appendChild(cwb)
          })
          // 彩虹色块 = 展开/收起**自带「确定 / 取消」**的取色盘。
          // 不再用原生 input[type=color]：原生盘没有确定键，只能点别处关闭（用户 2026-10-16 点名要明确按钮）。
          // 取色盘挂在卡片**内部**：wrap 已拦截 pointerdown/click，不会被宿主判成「点到了卡片外面」而关掉卡片。
          var cw = document.createElement('div')
          cw.title = '自定义颜色：点开取色盘，选完点「确定」'
          cw.style.cssText = 'position:relative;width:28px;height:28px;border-radius:8px;cursor:pointer;'
            + 'border:2px solid transparent;background:conic-gradient(#ff4444,#ffc300,#2ecc71,#00c8ff,#b06bff,#ff4444);'
          var cardPicker = null
          function closeCardPicker() {
            if (cardPicker !== null) { try { cardPicker.remove() } catch (_) { /* ignore */ } cardPicker = null }
          }
          cw.addEventListener('click', function (ev) {
            ev.stopPropagation()
            if (cardPicker !== null) { closeCardPicker(); return }
            resetPickerSeed(cur)
            cardPicker = document.createElement('div')
            cardPicker.style.cssText = 'flex:1 1 100%;margin-top:6px;'
            cardPicker.addEventListener('pointerdown', function (e) { e.stopPropagation() })
            cardPicker.addEventListener('click', function (e) { e.stopPropagation() })
            renderPicker(cardPicker, function (hex) {
              bindToCard(hex)   // 把颜色记到这条批注身上 + 立刻刷正文标记
              addCustom(hex)
              closeCardPicker()
            }, function () { closeCardPicker() })
            wrap.appendChild(cardPicker)
          })
          wrap.appendChild(cw)
          return wrap
        }
        colorRowBuilder = buildColorRow

        // ---------- @ 引用某一条批注（在输入框里打 @ 弹出批注清单）----------
        var mentionPanel = document.createElement('div')
        mentionPanel.id = 'dshap-mention'
        mentionPanel.style.cssText = 'display:none;position:fixed;z-index:2147483646;box-sizing:border-box;'
          + 'width:360px;max-height:40vh;overflow:auto;padding:8px;border-radius:10px;'
          + 'border:1px solid var(--dsw-alias-border-inverted,#444);'
          + 'background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-primary,#eee);'
          + 'font-family:var(--dsw-font-family,system-ui);font-size:12px;'
          + 'box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.4));'
        document.body.appendChild(mentionPanel)
        var mentionItems = []
        var mentionIdx = 0
        function composerInput() {
          try { return document.querySelector('[data-composer-card] [data-composer-input]') } catch (_) { return null }
        }
        function closeMention() { mentionPanel.style.display = 'none'; mentionItems = [] }
        function renderMention() {
          mentionPanel.innerHTML = ''
          if (mentionItems.length === 0) {
            var e0 = document.createElement('div')
            e0.textContent = '暂无批注可引用'
            e0.style.cssText = 'opacity:.6;padding:4px;'
            mentionPanel.appendChild(e0)
            return
          }
          for (var m = 0; m < mentionItems.length; m++) {
            (function (k) {
              var it = mentionItems[k]
              var row = document.createElement('div')
              row.textContent = (k + 1) + '. ' + (it.text || '') + (it.note ? '（批注：' + it.note + '）' : '')
              row.style.cssText = 'padding:5px 6px;border-radius:7px;cursor:pointer;white-space:nowrap;'
                + 'overflow:hidden;text-overflow:ellipsis;'
                + (k === mentionIdx ? 'background:rgba(127,127,127,.3);' : '')
              row.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); insertMention(it) })
              mentionPanel.appendChild(row)
            })(m)
          }
        }
        function placeMention() {
          var inp = composerInput()
          if (inp === null) return
          var r = inp.getBoundingClientRect()
          mentionPanel.style.left = Math.round(Math.max(8, r.left)) + 'px'
          mentionPanel.style.top = Math.round(Math.max(8, r.top - mentionPanel.offsetHeight - 8)) + 'px'
        }
        function openMention() {
          mentionItems = collectAnnotations()
          if (mentionItems.length === 0) return
          mentionIdx = 0
          renderMention()
          mentionPanel.style.display = 'block'
          placeMention()
          clampIntoView(mentionPanel)
        }
        function insertMention(it) {
          var txt = '引文：「' + (it.text || '') + '」' + (it.note ? '（批注：' + it.note + '）' : '') + '\n'
          var inp = composerInput()
          closeMention()
          if (inp === null) return
          try { inp.focus() } catch (_) { /* ignore */ }
          var ok = false
          try { ok = document.execCommand('insertText', false, txt) } catch (_) { ok = false }
          if (!ok) {
            try {
              if (typeof inp.value === 'string') inp.value = inp.value + txt
              else inp.textContent = (inp.textContent || '') + txt
              inp.dispatchEvent(new Event('input', { bubbles: true }))
            } catch (_) { /* ignore */ }
          }
        }
        function onMentionKey(e) {
          if (mentionPanel.style.display === 'block') {
            if (e.key === 'ArrowDown') { mentionIdx = Math.min(mentionIdx + 1, mentionItems.length - 1); renderMention(); e.preventDefault(); e.stopPropagation(); return }
            if (e.key === 'ArrowUp') { mentionIdx = Math.max(mentionIdx - 1, 0); renderMention(); e.preventDefault(); e.stopPropagation(); return }
            if (e.key === 'Enter') { insertMention(mentionItems[mentionIdx]); e.preventDefault(); e.stopPropagation(); return }
            if (e.key === 'Escape') { closeMention(); e.preventDefault(); e.stopPropagation(); return }
            return
          }
          if (e.key === '@') {
            var t = e.target
            if (t !== null && t.closest !== undefined && t.closest('[data-composer-card]') !== null) {
              setTimeout(openMention, 0)
            }
          }
        }
        // 挂在 window 捕获相：必须**早于**插件自己的 document 捕获 Enter（否则回车已经被它发出去）
        window.addEventListener('keydown', onMentionKey, true)

        return function () {
          try { document.removeEventListener('keydown', onKey, true) } catch (_) { /* ignore */ }
          try { document.removeEventListener('pointerdown', onDocDown, true) } catch (_) { /* ignore */ }
          try { document.removeEventListener('keydown', onKeyList, true) } catch (_) { /* ignore */ }
          try { window.removeEventListener('keydown', onMentionKey, true) } catch (_) { /* ignore */ }
          if (badgeTimer !== null) clearInterval(badgeTimer)
          if (markerObserver !== null) { try { markerObserver.disconnect() } catch (_) { /* ignore */ } markerObserver = null }
          if (listTimer !== null) { clearInterval(listTimer); listTimer = null }
          dot.remove(); panel.remove(); listBtn.remove(); listPanel.remove(); mentionPanel.remove()
          // 注意：**故意不删注入的 <style>**。apply() 会跑多次，每个实例的 cleanup 都会执行；
          // 若在这里删样式，就可能把"新实例刚检测到已存在、因而没重建"的那份样式删掉 ——
          // 于是高亮底色整片回退成插件的默认黄（这正是"颜色又丢了"的元凶之一）。
          // 样式是按 id 幂等的静态规则，留着无害。
        }
      })()
      // ② 2026-10-16 整段移除：这里原本留着一个「诊断探针」——量到圆点 DOM 尺寸为 0×0 时，
      //    用 !important 把 dot 强行撑成 120×120 的**红方块**，并在控制台打 ANNOT-PROBE 日志。
      //    它会在某些时机把那块红方块闪出来 —— 就是用户报的「莫名其妙出现一个红色的框，然后消失」。
      //    纯诊断代码、无任何外部引用（_probeDot/_info 都是块内局部量），删除后不影响任何功能。

      // 优先级（自上而下，命中即返回）：
      // ① uiSession 服务的 `adapter.current`（HostObservable<binding>，binding.key =
      //    sessionId）—— 0.1.7 起的公开选中态：selection 收进 ClientSessions 私有
      //    selection，list 快照不再带 current。已对照 0.1.7-rc.2 与 0.2.0-rc.2 内核
      //    源码核实（packages/client/ui-session/src/client/index.ts:312 起暴露）。
      // ② `localStorage['dsh.sessions.current'].sessionId` —— 内核 workspace 服务
      //    持久化的选择态（`createSnapshotStore({}, { persist: { name: ... } })`，
      //    写入形状 `{ sessionId }`，会话归档时由内核 clearArchivedCurrent 自行清理）。
      //    0.1.6-alpha.2 ~ 0.1.6 上这是唯一真实可用的路径（#68 的考证）。
      // ③ list 快照上的 `current` —— 0.1.6-alpha.2 之前的宿主，该字段是精确选中值。
      // ④ list 行上的 `retainedBy.mainView > 0` —— 公开成员，兜底「尚未落盘 / 存储
      //    被清」的场景。它是「主视图 retain 的会话」而非选中值：内核自己也只在
      //    id 未知时才用它猜，故排在精确值之后。
      // （曾挂在 sessions 服务上的 `currentProvideInfo` 只存在于旧源码线
      // packages/client/runtime，上游现契约已无此成员，不再尝试。）
      var uiSessionService = null

      /** ui-session 服务（惰性探测：apply 时机早于它注册时下次再取）。 */
      function uiSessionFace() {
        if (uiSessionService === null) {
          try { uiSessionService = ctx.get('uiSession') || null } catch (_) { uiSessionService = null }
        }
        return uiSessionService
      }

      /** ① 命中时返回可订阅的选中态源（HostObservable），否则 null。 */
      function currentSessionSource() {
        try {
          var face = uiSessionFace()
          var adapter = face !== null ? face.adapter : undefined
          var source = adapter !== undefined && adapter !== null ? adapter.current : undefined
          if (source !== undefined && source !== null
            && typeof source.getSnapshot === 'function' && typeof source.subscribe === 'function') return source
        } catch (_) { /* 旧版内核：无 uiSession */ }
        return null
      }

      function readCurrentSessionId() {
        try {
          var source = currentSessionSource()
          if (source !== null) {
            var binding = source.getSnapshot()
            if (binding !== undefined && binding !== null && binding.key !== undefined) return binding.key
          }
        } catch (_) { /* 落到下一级 */ }
        try {
          if (typeof localStorage !== 'undefined') {
            var raw = localStorage.getItem('dsh.sessions.current')
            if (raw !== null) {
              var parsed = JSON.parse(raw)
              if (parsed !== null && typeof parsed === 'object'
                && typeof parsed.sessionId === 'string' && parsed.sessionId !== '') return parsed.sessionId
            }
          }
        } catch (_) { /* 落到下一级 */ }
        try {
          var snap = sessions.list.getSnapshot()
          if (snap !== undefined && snap !== null) {
            if (typeof snap.current === 'string' && snap.current !== '') return snap.current
            var byId = snap.byId
            if (byId !== undefined && byId !== null && typeof byId === 'object') {
              var ids = Array.isArray(snap.ids) ? snap.ids : Object.keys(byId)
              for (var i = 0; i < ids.length; i++) {
                var retained = byId[ids[i]] !== undefined && byId[ids[i]] !== null
                  ? byId[ids[i]].retainedBy : null
                if (retained !== null && typeof retained === 'object'
                  && typeof retained.mainView === 'number' && retained.mainView > 0) return ids[i]
              }
            }
          }
        } catch (_) { /* 落到下一级 */ }
        return undefined
      }

      var host = document.createElement('div')
      host.setAttribute('data-annotation-for-dsh', '')
      document.body.appendChild(host)
      var overlay = document.createElement('div')
      overlay.setAttribute('data-annotation-overlay', '')
      overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:900;'
      document.body.appendChild(overlay)

      // 编号单独成层：overlay 是 z-index 900 的 stacking context，编号挂在里面
      // 只能跟着它走——既会被宿主里层级更高的内容压住，也会被输入框/头部的
      // 裁剪一起切掉（表现为「滚到输入框上就不显示」）。分层之后编号有自己
      // 统一的层级（1100，仍低于胶囊/菜单层），不随宿主文档结构变化，也不再
      // 参与标记层的裁剪。
      var numLayer = document.createElement('div')
      numLayer.setAttribute('data-annotation-num-layer', '')
      numLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1100;'
      document.body.appendChild(numLayer)

      var ui = {
        mode: 'closed',      // closed | actions | editing | composing
        editingId: null,     // 非空 = 正在编辑该 id 的已有批注（点角标进入）
        quote: '',
        quotes: [],          // [{ id, text, note, range, seqKey, rowHead, textOffset, ctxBefore, ctxAfter }]
        noteDraft: '',
        pos: { left: 0, top: 0 },
        error: null,
        busy: false,
        lastKey: '',
        pendingAnchor: null,
        el: null,
      }

      function readPendingQuotes(sessionId) {
        if (sessionId === undefined) return []
        try {
          return parsePendingQuotes(localStorage.getItem(pendingStorageKey(sessionId)))
        } catch (err) {
          console.warn('[annotation] 读取待发送批注失败：', err)
          return []
        }
      }

      function writePendingQuotes(sessionId) {
        if (sessionId === undefined) return
        try {
          var key = pendingStorageKey(sessionId)
          if (ui.quotes.length === 0) localStorage.removeItem(key)
          else localStorage.setItem(key, stringifyPendingQuotes(ui.quotes))
        } catch (err) {
          console.warn('[annotation] 保存待发送批注失败：', err)
        }
      }

      function writeCurrentPendingQuotes() {
        writePendingQuotes(readCurrentSessionId())
      }

      var ignoreUntil = 0
      var settleTimer = null

      // ---------- IME 合成 latch（对齐官方 InputBar composingRef）----------
      // macOS / 豆包等：compositionend 之后才会到 keydown(Enter, isComposing=false,
      // keyCode=13)，仅查 isComposing / 229 挡不住「上屏确认 Enter」。若此时
      // attachAndSend → setDraft，会打断合成，表现为只能打出拼音字母。
      // 延迟清 latch 与 InputBar 一致（略放宽到 50ms，兼容第三方输入法时序）。
      var imeComposing = false
      var imeClearTimer = null
      var imeTouchedAt = 0
      function markImeComposing() {
        imeComposing = true
        imeTouchedAt = Date.now()
        if (imeClearTimer !== null) {
          clearTimeout(imeClearTimer)
          imeClearTimer = null
        }
      }
      function markImeEnded() {
        if (imeClearTimer !== null) clearTimeout(imeClearTimer)
        imeClearTimer = setTimeout(function () {
          imeComposing = false
          imeClearTimer = null
        }, 50)
      }
      /** @param {KeyboardEvent} e */
      function isImeKeyBlocked(e) {
        if (e.isComposing === true || e.keyCode === 229) {
          imeTouchedAt = Date.now()
          return true
        }
        // compositionend 偶尔会丢失。只在浏览器已明确报告「非合成」且 latch
        // 1.2 秒没有活动时复位，避免一次异常把之后所有 Enter 永久锁死。
        if (imeComposing && imeClearTimer === null && Date.now() - imeTouchedAt >= 1200) {
          imeComposing = false
        }
        return imeComposing
      }
      document.addEventListener('compositionstart', markImeComposing, true)
      document.addEventListener('compositionend', markImeEnded, true)

      // ---------- 轻提示 ----------
      var toastTimer = null
      function showToast(msg) {
        try {
          var old = document.querySelector('[data-annotation-toast]')
          if (old !== null) old.remove()
          var el = document.createElement('div')
          el.setAttribute('data-annotation-toast', '')
          el.textContent = msg
          el.style.cssText = 'position:fixed;z-index:1300;left:50%;bottom:88px;transform:translateX(-50%);max-width:min(420px,calc(100vw - 24px));padding:8px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #2c2c2e));border:1px solid var(--dsw-alias-border-inverted);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,system-ui);font-size:12px;pointer-events:none;'
          document.body.appendChild(el)
          if (toastTimer !== null) clearTimeout(toastTimer)
          toastTimer = setTimeout(function () {
            toastTimer = null
            if (el.parentNode) el.parentNode.removeChild(el)
          }, 3000)
        } catch (_) { /* toast 失败忽略 */ }
      }

      // ---------- 选区监听 ----------
      function selectionKey(sel) {
        if (sel === null || sel.rangeCount === 0) return ''
        var r = sel.getRangeAt(0)
        return String(r.startContainer === r.endContainer ? 1 : 0)
          + ':' + r.startOffset + ':' + r.endOffset + ':' + sel.toString().length
      }

      function onSelection() {
        if (ui.mode !== 'closed' && host.childNodes.length === 0) {
          ui.mode = 'closed'
          ui.lastKey = ''
        }
        if (ui.mode === 'editing' || ui.mode === 'composing' || ignoreUntil > Date.now()) return
        var sel = window.getSelection()
        if (sel === null || sel.isCollapsed || sel.rangeCount === 0) {
          clearSettle()
          return
        }
        var range = sel.getRangeAt(0)
        var anc = range.commonAncestorContainer
        var ancEl = anc instanceof Element ? anc : (anc && anc.parentElement)
        if (ancEl !== null && ancEl.closest) {
          if (ancEl.closest('[data-annotation-for-dsh]') || ancEl.closest('[data-annotation-overlay]')
            || ancEl.closest('[data-annotation-num-layer]')
            || ancEl.closest('[data-composer-card]') || ancEl.closest('[data-input-scroll]')) {
            clearSettle()
            return
          }
        }
        if (host.contains(anc) || overlay.contains(anc) || numLayer.contains(anc)) {
          clearSettle()
          return
        }
        var text = sel.toString().trim()
        if (text.length === 0) { clearSettle(); return }
        var key = selectionKey(sel)
        var rootEl = annotationRootOf(range.commonAncestorContainer)
        var source = documentSourceOf(range.commonAncestorContainer)
        var selSessionId = readCurrentSessionId()
        if (source !== null && selSessionId !== undefined && source.sessionId !== selSessionId) rootEl = null
        if (rootEl === null) { clearSettle(); closeToolbar(); return }
        if (ui.mode === 'actions' && key === ui.lastKey && text === ui.quote && rootEl === ui.selectionRoot
          && (ui.source && ui.source.sourceUrl) === (source && source.sourceUrl)) { clearSettle(); return }
        clearSettle()
        settleTimer = setTimeout(function () {
          settleTimer = null
          if (ui.mode === 'editing' || ui.mode === 'composing') return
          var s = window.getSelection()
          if (s === null || s.isCollapsed || selectionKey(s) !== key) return
          var r = s.getRangeAt(0)
          if (annotationRootOf(r.commonAncestorContainer) !== rootEl) return
          var currentSource = documentSourceOf(r.commonAncestorContainer)
          var settleSessionId = readCurrentSessionId()
          if ((currentSource && currentSource.sourceUrl) !== (source && source.sourceUrl)
            || (source !== null && settleSessionId !== undefined && source.sessionId !== settleSessionId)) return
          var rect = r.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return
          var p = placeAbove(rect, 40)
          if (ui.mode === 'actions' && ui.quote === text && (ui.source && ui.source.sourceUrl) === (source && source.sourceUrl)) {
            ui.lastKey = key
            ui.pos = p
            if (ui.el !== null && ui.el.style) {
              ui.el.style.left = p.left + 'px'
              ui.el.style.top = p.top + 'px'
            }
            return
          }
          ui.lastKey = key
          ui.mode = 'actions'
          ui.quote = text
          ui.source = source
          ui.selectionRoot = rootEl
          ui.error = null
          ui.pos = p
          render()
        }, 250)
      }
      document.addEventListener('selectionchange', onSelection)

      function clearSettle() {
        if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
      }

      function onHostPointerDown() { ignoreUntil = Date.now() + 80 }
      host.addEventListener('pointerdown', onHostPointerDown)

      function onDocPointerDown(e) {
        if (ui.mode === 'actions' && !host.contains(e.target) && !overlay.contains(e.target)) {
          closeToolbar()
        }
      }
      document.addEventListener('pointerdown', onDocPointerDown, true)

      var anchorRaf = false
      var lostSince = 0
      var ANCHOR_LOST_MS = 1000
      function onLayoutChange() {
        if (anchorRaf) return
        anchorRaf = true
        requestAnimationFrame(function () {
          anchorRaf = false
          // 滚动进行中（followSettleTimer 还在）就跳过这次全量重画 —— 标记此刻由 translateY 跟手，
          // 等滚动停下 140ms 再由 followSettleTimer 重画一次。这是「半天才挪过来」的根治点。
          if (ui.quotes.length > 0) {
            if (followSettleTimer === null) renderMarkers()
          } else if (followSettleTimer === null && markerListFor().length > 0) {
            renderMarkers()
          }
          updateChip()
          if (ui.mode === 'editing' && ui.el !== null) positionEditor(ui.el, ui.pos.left, ui.pos.top)
          if (ui.mode !== 'actions' || ui.quote === '') return
          var rect = null
          var sel = window.getSelection()
          if (sel !== null && !sel.isCollapsed && sel.rangeCount > 0) {
            var live = sel.getRangeAt(0)
            if (annotationRootOf(live.commonAncestorContainer) === ui.selectionRoot
              && (documentSourceOf(live.commonAncestorContainer)?.sourceUrl || '') === (ui.source && ui.source.sourceUrl || '')
              && sel.toString().trim() === ui.quote) {
              rect = live.getBoundingClientRect()
            }
          }
          if (rect === null) {
            var range = locateQuote(ui.quote, ui.source)
            if (range !== null) rect = range.getBoundingClientRect()
          }
          if (rect === null || rect.width === 0 || rect.height === 0) {
            if (lostSince === 0) lostSince = Date.now()
            if (Date.now() - lostSince > ANCHOR_LOST_MS) { lostSince = 0; closeToolbar() }
            return
          }
          lostSince = 0
          var p = placeAbove(rect, 40)
          if (Math.abs(p.left - ui.pos.left) + Math.abs(p.top - ui.pos.top) > 2) {
            ui.pos = p
            if (ui.el !== null && ui.el.style) {
              ui.el.style.left = p.left + 'px'
              ui.el.style.top = p.top + 'px'
            } else {
              render()
            }
          }
        })
      }
      window.addEventListener('scroll', onLayoutChange, true)
      window.addEventListener('resize', onLayoutChange)

      // ==== 2026-10-16 滚动「跟手」优化（只改插件内部，不动标记层的挂载方式）====
      // 改前：每滚一帧 onLayoutChange 都跑 renderMarkers()，而它要 locateQuote() 在 DOM 里
      //      重新找每条批注的原文、再 getClientRects() 量位置、再重建节点 —— 主线程跟不上滚动帧，
      //      标记就成了「半天才挪过来」。
      // 改后：滚动期间**只**给现成的两层做 translateY（合成层操作，一帧两次赋值，零查找零布局），
      //      标记贴着文字一起走；滚停 ~140ms 才真正重画一次（那时画面是静止的，慢也看不见）。
      // 安全：全程 try/catch —— 任何异常立即 followEnabled = false，行为退回改前。
      var FOLLOW_SETTLE_MS = 140
      var followEnabled = true
      var followBaseTop = null      // 上一次真画标记时，滚动容器的 scrollTop
      var followY = 0               // 当前生效的平移量
      var followSettleTimer = null
      function followScroller() {
        try {
          var sc = document.querySelector('[data-conversation-scroll]')
          if (sc === null || typeof sc.scrollTop !== 'number') return null
          return sc
        } catch (_) { return null }
      }
      function applyFollow() {
        try {
          if (!followEnabled) return
          var sc = followScroller()
          if (sc === null || followBaseTop === null) return
          var want = followBaseTop - sc.scrollTop
          if (Math.abs(want - followY) < 0.5) return
          followY = want
          var tr = want === 0 ? '' : 'translateY(' + want + 'px)'
          if (overlay.style.transform !== tr) overlay.style.transform = tr
          if (numLayer.style.transform !== tr) numLayer.style.transform = tr
        } catch (_) { followEnabled = false }
      }
      function noteFollowBaseline() {
        try {
          if (!followEnabled) return
          var sc = followScroller()
          if (sc === null) return
          followBaseTop = sc.scrollTop
          followY = 0
          overlay.style.transform = ''
          numLayer.style.transform = ''
        } catch (_) { followEnabled = false }
      }
      function onScrollFollow() {
        try {
          if (!followEnabled) return
          var sc = followScroller()
          if (sc === null) return
          if (followBaseTop === null) { noteFollowBaseline(); return }
          applyFollow()
          if (followSettleTimer !== null) clearTimeout(followSettleTimer)
          followSettleTimer = setTimeout(function () {
            followSettleTimer = null
            try {
              if (markerListFor().length > 0) { markersSig = null; renderMarkers() }
            } catch (_) { /* ignore */ }
          }, FOLLOW_SETTLE_MS)
        } catch (_) { followEnabled = false }
      }
      window.addEventListener('scroll', onScrollFollow, true)

      function mutationRelevant(mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var t = mutations[i].target
          var el = t instanceof Element ? t : (t && t.parentElement)
          if (el === null || !el.closest) return true
          if (el.closest('[data-composer-card]') || el.closest('[data-input-scroll]')
            || el.closest('[data-annotation-for-dsh]') || el.closest('[data-annotation-overlay]')
            || el.closest('[data-annotation-num-layer]')
            || el.closest('[data-annotation-chip]') || el.closest('[data-annotation-tip-layer]')) {
            continue
          }
          return true
        }
        return false
      }
      var observer = new MutationObserver(function (mutations) {
        if (!mutationRelevant(mutations)) return
        onLayoutChange()
        // 只有「消息行插入」批次才同步执行气泡装饰（隐藏批注块 + 贴标签）：
        // MutationObserver 回调在微任务阶段运行，早于浏览器绘制，
        // 用户看不到「先显示批注块再隐藏」的闪烁。
        // 流式输出期的主体 mutation 是 attributes/characterData（每个 token 帧一层
        // class/style/文本变更，实测 20s 内 245 批次 0 个 childList）：行插入本来
        // 就携带完整批注块，逐一触发全文档扫描（decorateAll 是 querySelectorAll +
        // 每行子树查询 + textContent，成本随会话长度线性增长）会在长会话上白白
        // 烧主线程；漏网场景由下方 1s 兜底轮询覆盖。
        var hasRowInsert = false
        for (var i = 0; i < mutations.length; i++) {
          if (mutations[i].type === 'childList') { hasRowInsert = true; break }
        }
        if (hasRowInsert) {
          scheduleDecorateAll()
          return
        }
        // 流式批次: 只做助手回复芯片的限流装饰(行内 data-streaming 守卫已保证
        // 流式中不做替换, 结束后的首拍芯片滞后 ≤500ms), 不再逐批全文档扫描。
        scheduleAssistantDecorate()
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })

      function onKeyDown(e) {
        if (e.key === 'Escape') {
          if (ui.mode !== 'closed') closeToolbar()
          return
        }
        // 【回车随输入框发送】在 composer 里按 Enter（且已收集批注、非输入法合成）：
        // 提交前一刻把批注块拼进草稿，composer 自己的 Enter 提交继续——模型收到
        // 批注清单 + 用户输入的问题。用户始终看不到文本被塞进去。
        // IME 铁律（v1.3.10 修了 nativeEvent.keyCode；v1.3.11 补 compositionend
        // 后 Enter keyCode=13 的时序洞）：合成期 / 上屏确认 Enter 绝不能 setDraft。
        // 修饰键守卫（v1.3.18 修 issue #10）：Shift+Enter 换行、Alt+Enter 默认路径
        // 不触发拼稿；裸 Enter 继续处理带文字草稿，Cmd/Ctrl+Enter 只接管空草稿
        // 的纯批注。已有文字时交回 composer，保留宿主的 Queue / Steer 策略。
        // 纯批注的 Cmd/Ctrl+Enter 需要在这里直接提交：composer 的 accelerated 路径在
        // 「运行中 + 有排队消息」时会走 steerQueue，而不是发送当前草稿；我们在
        // capture 阶段 setDraft 后 stopPropagation，主动 submit('queue')，保证
        // 纯批注能直接发出，同时不会把批注块明文留在输入框。
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey
          && ui.quotes.length > 0) {
          // 双分支门控：DSH ≥0.1.2 是 div[data-composer-input] 输入区，≤0.1.1 是 textarea。
          // 1.4.6 适配 0.1.2 时移除了 textarea 分支，旧核心上 Enter 因此不再拼入批注块
          // （只剩发送按钮路径可用）。两条分支并行保留。
          var input = e.target instanceof Element &&
            (e.target.closest('[data-composer-input]') ||
              (e.target instanceof HTMLTextAreaElement && e.target.closest('[data-composer-card]')))
          if (input && input.closest('[data-composer-card]') !== null) {
            if (isImeKeyBlocked(e)) {
              // 宿主的合成尾窗可能短于这里的 50ms。仅在本来会拼批注的
              // 手势上拦住宿主提交；不 preventDefault，保留输入法确认行为。
              if (shouldGuardImeEnter(e)) e.stopPropagation()
              return
            }
            var attached = attachAndSend(e)
            if (attached && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              e.stopPropagation()
              submitAttached()
            }
          }
        }
      }
      // capture 阶段：必须先于 composer 自己的 Enter 处理（React 在容器层冒泡
      // 提交）——否则等我们执行时消息已提交，拼稿永远太迟。
      document.addEventListener('keydown', onKeyDown, true)

      function submitAttached() {
        var current = readCurrentSessionId()
        if (current === undefined) {
          console.warn('[annotation] 无法确定当前会话，批注直接提交已跳过')
          return
        }
        var scoped = sessions.scope(current)
        if (scoped === undefined) {
          console.warn('[annotation] 当前会话 scope 不可用，批注直接提交已跳过')
          return
        }
        try {
          ctx.conversation.input.for(scoped).submit('queue')
        } catch (err) {
          console.warn('[annotation] 批注直接提交失败：', err)
        }
      }

      function sendButtonOf(target) {
        if (!(target instanceof Element) || typeof target.closest !== 'function') return null
        var button = target.closest('button')
        if (!(button instanceof HTMLButtonElement)
          || button.closest('[data-composer-card]') === null) return null
        var label = button.getAttribute('aria-label')
        return label === '发送消息' || label === 'Send message' ? button : null
      }

      // 鼠标/触控发送不经过 textarea 的 Enter 路径。pointerdown 能覆盖宿主因
      // 空草稿而禁用的发送按钮；已有文字时只拼稿，后续 click 仍由宿主提交。
      function onSendPointerDown(e) {
        if (ui.quotes.length === 0 || e.button !== 0) return
        var button = sendButtonOf(e.target)
        if (button === null) return
        var wasDisabled = button.disabled
        if (!attachAndSend({ ctrlKey: false, metaKey: false }) || !wasDisabled) return
        e.preventDefault()
        e.stopPropagation()
        submitAttached()
      }

      // 键盘/辅助技术激活按钮时没有 pointerdown，以 detail=0 的 click 补齐。
      function onSendKeyboardClick(e) {
        if (e.detail !== 0 || ui.quotes.length === 0 || sendButtonOf(e.target) === null) return
        attachAndSend({ ctrlKey: false, metaKey: false })
      }
      document.addEventListener('pointerdown', onSendPointerDown, true)
      document.addEventListener('click', onSendKeyboardClick, true)

      // ---------- 渲染 ----------
      function iconButton(cls, icon, title, onClick) {
        var b = document.createElement('button')
        b.type = 'button'
        b.className = cls
        b.title = title
        b.appendChild(icon())
        b.addEventListener('click', function () { ignoreUntil = Date.now() + 80; onClick() })
        return b
      }

      function ghostButton(icon, label, title, disabled, onClick) {
        var b = document.createElement('button')
        b.type = 'button'
        b.className = 'dsh-ann-ghost'
        b.title = title
        if (icon !== null) b.appendChild(icon())
        b.appendChild(document.createTextNode(label))
        b.disabled = disabled === true
        b.addEventListener('click', function () { ignoreUntil = Date.now() + 80; onClick() })
        return b
      }

      function render() {
        host.textContent = ''
        ui.el = null
        if (ui.mode === 'actions') {
          var bar = document.createElement('div')
          bar.className = 'dsh-ann-bar'
          bar.style.left = ui.pos.left + 'px'
          bar.style.top = ui.pos.top + 'px'
          var already = ui.quotes.some(function (q) { return q.text === ui.quote && (q.sourceUrl || '') === (ui.source && ui.source.sourceUrl || '') })
          bar.appendChild(ghostButton(
            already ? null : ICONS.plus,
            already ? t('actions.already') : t('actions.annotate'),
            already ? t('actions.alreadyTitle') : t('actions.annotateTitle'),
            already,
            enterEditing,
          ))
          host.appendChild(bar)
          ui.el = bar
        } else if (ui.mode === 'editing') {
          var card = document.createElement('div')
          card.className = 'dsh-ann-card'
          card.style.left = ui.pos.left + 'px'
          card.style.top = ui.pos.top + 'px'
          ui.el = card
          var head = document.createElement('div')
          head.className = 'dsh-ann-card-head'
          makeEditorDraggable(head, card)
          var headMain = document.createElement('div')
          headMain.className = 'dsh-ann-card-headmain'
          var title = document.createElement('div')
          title.className = 'dsh-ann-card-title'
          title.textContent = ui.editingId !== null ? t('edit.editTitle') : t('edit.addTitle')
          headMain.appendChild(title)
          // 编辑已有批注时，标题右侧紧邻一个删除按钮（新增批注没有可删对象）。
          if (ui.editingId !== null) {
            var editingId = ui.editingId
            var del = document.createElement('button')
            del.type = 'button'
            del.className = 'dsh-ann-qdel'
            del.title = t('edit.delete')
            del.setAttribute('aria-label', t('edit.delete'))
            del.appendChild(ICONS.trash())
            del.addEventListener('click', function () {
              closeToolbar()
              removeQuote(editingId)
            })
            headMain.appendChild(del)
          }
          head.appendChild(headMain)
          head.appendChild(iconButton('dsh-ann-icon', ICONS.close, t('common.cancel'), closeToolbar))
          card.appendChild(head)
          var quote = document.createElement('div')
          quote.className = 'dsh-ann-quote'
          quote.textContent = truncate(quoteWithSource({ text: ui.quote, sourcePath: ui.source && ui.source.sourcePath }), 200)
          quote.title = quoteWithSource({ text: ui.quote, sourcePath: ui.source && ui.source.sourcePath })
          card.appendChild(quote)
          var ta = document.createElement('textarea')
          ta.className = 'dsh-ann-input'
          ta.placeholder = t('edit.placeholder')
          ta.value = ui.noteDraft
          ta.spellcheck = false
          ta.addEventListener('input', function () { ui.noteDraft = ta.value })
          ta.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey && !isImeKeyBlocked(e)) { e.preventDefault(); saveAnnotation() }
          })
          card.appendChild(ta)
          // 本地升级：把配色行直接放进"添加/编辑批注"卡片（就地选色）
          try {
            // 新建批注：若当前有选定颜色，先把这条记成那个颜色（"每支笔记自己的色"）。
            // 编辑已有批注时不预置，避免一碰卡片就把老颜色刷掉。
            if (ui.editingId === null && typeof ui.quote === 'string' && ui.quote !== '') {
              var _curPen = readColor()
              if (_curPen !== null) rememberItemColor(ui.quote, _curPen)
            }
          } catch (_) { /* ignore */ }
          try {
            if (typeof colorRowBuilder === 'function') {
              var _colorRow = colorRowBuilder()
              if (_colorRow !== null) card.appendChild(_colorRow)
            }
          } catch (_) { /* ignore */ }
          var row = document.createElement('div')
          row.className = 'dsh-ann-row'
          var save = document.createElement('button')
          save.type = 'button'
          save.className = 'dsh-ann-action'
          save.appendChild(ICONS.check())
          save.appendChild(document.createTextNode(t('edit.save')))
          save.addEventListener('click', saveAnnotation)
          row.appendChild(save)
          card.appendChild(row)
          if (ui.error !== null) {
            var err = document.createElement('div')
            err.className = 'dsh-ann-error'
            err.textContent = ui.error
            card.appendChild(err)
          }
          host.appendChild(card)
          ta.focus()
          ta.setSelectionRange(ta.value.length, ta.value.length)
          requestAnimationFrame(function () {
            if (card.isConnected) positionEditor(card, ui.pos.left, ui.pos.top)
          })
        }
      }

      function positionEditor(card, left, top) {
        ui.pos = {
          left: Math.max(8, Math.min(left, window.innerWidth - card.offsetWidth - 8)),
          top: Math.max(8, Math.min(top, window.innerHeight - card.offsetHeight - 8)),
        }
        card.style.left = ui.pos.left + 'px'
        card.style.top = ui.pos.top + 'px'
      }

      function makeEditorDraggable(head, card) {
        var drag = null
        head.addEventListener('pointerdown', function (e) {
          if (e.button !== 0 || !e.isPrimary || e.target.closest('button')) return
          var r = card.getBoundingClientRect()
          drag = { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top }
          head.setPointerCapture(e.pointerId)
          e.preventDefault()
        })
        head.addEventListener('pointermove', function (e) {
          if (drag === null || e.pointerId !== drag.id) return
          positionEditor(card, e.clientX - drag.x, e.clientY - drag.y)
        })
        head.addEventListener('lostpointercapture', function () { drag = null })
      }

      // ---------- 批注标记 ----------
      var markersSig = null
      function markersSignature(blockers) {
        var parts = []
        var sigList = markerListFor()
        for (var i = 0; i < sigList.length; i++) {
          var q = sigList[i]
          var range = locateQuote(q.text, q)
          if (range === null) { parts.push(q.id + ':gone'); continue }
          var rects = quoteRects(range, q)
          for (var c = 0; c < rects.length; c++) {
            var r = rects[c]
            if (r.width === 0 || r.height === 0) continue
            parts.push(q.id + ':' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ',' + Math.round(r.height))
          }
          if (rects.length > 0) parts.push(q.id + ':chip')
        }
        // 遮挡区（输入框 + 会话头部）也进签名：它们改变时编号必须重走
        // 让位/隐藏，否则旧位置会被裁剪成半截残影。
        for (var b = 0; b < blockers.length; b++) {
          var br = blockers[b]
          parts.push('b:' + Math.round(br.left) + ',' + Math.round(br.top) + ',' + Math.round(br.width) + ',' + Math.round(br.height))
        }
        return parts.join('|')
      }

      /** 按 CSS Modules local 名取宿主元素的可见矩形：类名形如 `wSkVaW_header`
       *  （哈希前缀随版本变），故认「以 _<local> 收尾的 class token」，
       *  headerActions / composerSeatInner 这类同前缀兄弟名不会被误认。 */
      function hostLocalRects(local) {
        var out = []
        var found = document.querySelectorAll('[class*="_' + local + '"]')
        var re = new RegExp('(^|\\s)[^\\s]*_' + local + '(\\s|$)')
        for (var i = 0; i < found.length; i++) {
          var cls = found[i].getAttribute('class') || ''
          if (!re.test(cls)) continue
          var r = found[i].getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) continue
          if (r.bottom <= 0 || r.top >= window.innerHeight) continue
          out.push(r)
        }
        return out
      }

      /** 会话列的可视范围（x 轴 + 上沿）：优先 `data-conversation-scroll`（#63，
       *  data 属性跨版本稳定，已核实 0.2.0-rc.2 仍在 ui-chat/ChatView.tsx），
       *  找不到时退回 scrollBody 类名启发式取并集。侧边栏文件预览的批注与
       *  顶栏横带在 x 轴上重叠（#57），顶栏挖洞必须限制在会话列内。 */
      function conversationColumnRange() {
        var view = document.querySelector('[data-conversation-scroll]')
        var r = view !== null && typeof view.getBoundingClientRect === 'function'
          ? view.getBoundingClientRect() : null
        if (r === null || r.width <= 0) {
          var rects = hostLocalRects('scrollBody')
          if (rects.length === 0) return null
          var left = Infinity
          var right = -Infinity
          var top = Infinity
          for (var i = 0; i < rects.length; i++) {
            left = Math.min(left, rects[i].left)
            right = Math.max(right, rects[i].right)
            top = Math.min(top, rects[i].top)
          }
          return { left: left, right: right, top: top }
        }
        return { left: r.left, right: r.right, top: r.top }
      }

      /** 会盖住会话内容的宿主头部：标记层是 fixed 定位，原生绘制顺序上恒在
       *  头部之上——只有把头部区域从标记层裁掉，编号与高亮才会像会话内容
       *  一样被头部遮住。
       *  #63：只取会话列以内的部分。顶栏横带在侧边栏上方同样延伸，若整幅
       *  裁掉会把侧边栏文件批注一并裁掉；且类名启发式（_<header>）也会误中
       *  侧边栏自己的头——故逐个矩形与会话列求交，完全在列外的直接丢弃。 */
      function hostHeaderRects() {
        var col = conversationColumnRange()
        var rects = hostLocalRects('header')
        if (col === null) return []
        var out = []
        for (var i = 0; i < rects.length; i++) {
          var r = rects[i]
          var left = Math.max(r.left, col.left)
          var right = Math.min(r.right, col.right)
          if (right - left <= 0) continue
          out.push({
            left: left, right: right, top: r.top, bottom: r.bottom,
            width: right - left, height: r.bottom - r.top,
          })
        }
        return out
      }

/** 输入区（整块 composer 容器，含输入卡片与下方统计行）——不是单个
       *  `[data-composer-card]`：卡片下方那段同样被容器盖住，编号落在那里
       *  会像「显示在对话区下面」。找不到容器时退回输入卡片。 */
      function hostComposerRects() {
        var rects = hostLocalRects('composerSeat')
        if (rects.length > 0) return rects
        var card = document.querySelector('[data-composer-card]')
        if (card === null) return []
        var r = card.getBoundingClientRect()
        return r.width > 0 && r.height > 0 ? [r] : []
      }

      /** 外框保留、逐个矩形挖空（evenodd）：标记层的裁剪路径。 */
      function clipWithHoles(rects) {
        var d = 'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0'
        for (var i = 0; i < rects.length; i++) {
          var r = rects[i]
          d += ', ' + r.left + 'px ' + r.top + 'px, ' + r.right + 'px ' + r.top + 'px, '
            + r.right + 'px ' + r.bottom + 'px, ' + r.left + 'px ' + r.bottom + 'px, '
            + r.left + 'px ' + r.top + 'px'
        }
        return d + ')'
      }

      function renderMarkers() {
        // 2026-10-16 本地升级（用户要求"滚动时标记别消失"）：只挖去输入区，
        // 不再挖会话头部 → 原文滚到标题栏下面时高亮/编号仍可见，不再整条消失。
        var holes = hostComposerRects()
        overlay.style.clipPath = holes.length > 0 ? clipWithHoles(holes) : 'none'
        // 编号层用同一条裁剪路径兜底：编号只允许出现在会话内容可视区里，
        // 绝不压在输入框或会话头部之上（定位逻辑已先让位/隐藏，这里是保险）。
        numLayer.style.clipPath = overlay.style.clipPath
        var sig = markersSignature(holes)

        if (sig !== markersSig) {
          markersSig = sig
          overlay.textContent = ''
          numLayer.textContent = ''
          buildMarkers()
        }
        noteFollowBaseline()   // 记下「这批标记对应的滚动位置」，跟手平移量归零
      }

      // ==== 2026-10-16 ③「重启后正文标记消失」的安全版修复（只加"登记恢复"这一件事）====
      // 原因：批注发送后条目只存在页面内存里（ui.quotes 被清空、localStorage 的待发送表也删了），
      //      但**批注块一直留在消息原文里** —— decorateAll 本来就会把每条消息的批注重新解析出来，
      //      以前那份数据只喂给鼠标悬停面板，正文标记（色块 + 编号）拿不到，所以一重启就空。
      // 这里只把恢复出来的那批登记一份、画标记时一起用；拿不到就退回 ui.quotes，行为同改前。
      var restoredItems = []
      function markerListFor() {
        try {
          if (restoredItems.length === 0) {
            // 2026-10-16 ④ 重启兜底：万一 buildMarkers 先于 decorateAll 跑到（重启后正文标记会空），
            // 就地把已经贴好的用户气泡标签扫一遍，用它们自带的 __annotationItems 临时登记。
            // 选择器/取数方式与 collectAnnotations 第②段（1520-1540 行）完全一致：标签是
            // [data-annotation-bubble-tag]，条目挂在 tag.__annotationItems（不是宿主容器上）。
            // 不改任何状态结构、不新增存储；扫不到就照旧退回 ui.quotes（行为同改前）。
            try {
              var tags = document.querySelectorAll('[data-annotation-bubble-tag]')
              for (var ri = 0; ri < tags.length; ri++) {
                var its = tags[ri].__annotationItems
                if (its && its.length) {
                  // ⑩ 顺带把标签所在行传进去，让恢复出来的条目也有行锚点
                  var rowOfTag = null
                  try {
                    rowOfTag = tags[ri].closest('[data-chat-flow-kind], [data-time-hover-root]')
                  } catch (_) { rowOfTag = null }
                  registerRestoredItems(its, rowOfTag)
                }
              }
            } catch (_) { /* 忽略 */ }
          }
          if (restoredItems.length > 0) return restoredItems.concat(ui.quotes || [])
        } catch (_) { /* 退回下面 */ }
        try { return ui.quotes || [] } catch (_) { return [] }
      }
      function registerRestoredItems(items, rowEl) {
        try {
          if (!items || !items.length) return
          // 2026-10-17 ⑩：登记时顺手带上「行级锚点」（seqKey + rowHead，语义对齐 :789 的
          // rowHead 分支：rowHead = 该行 textContent 的原样前 24 字）。
          // 以前这里只登记文本，locateQuote 的四个锚点分支全被跳过 → 只能走全局扫描，
          // 而扫描的接受门槛在"没有上下文"时恒为假 → 这批条目一个标记也画不出来
          // （遥测实测：items=4、hl=0；对照 anchored 那份 hl=20）。带行锚点后走 :789。
          var rowKey = ''
          var rowHead = ''
          try {
            if (rowEl !== null && rowEl !== undefined) {
              rowKey = rowEl.getAttribute('data-chat-anchor-key')
                || rowEl.getAttribute('data-focus-anchor-key') || ''
              rowHead = String(rowEl.textContent || '').slice(0, 24)
            }
          } catch (_) { /* 拿不到就当没有锚点，行为同改前 */ }
          var block = []
          for (var i = 0; i < items.length; i++) {
            var it = items[i]
            if (!it || !it.text) continue
            var txt = String(it.text)
            if (txt === '') continue
            var dup = false
            for (var j = 0; j < restoredItems.length; j++) { if (restoredItems[j].text === txt) { dup = true; break } }
            for (var k = 0; k < block.length; k++) { if (block[k].text === txt) { dup = true; break } }
            if (!dup) {
              // ⑩b：把「这条原文在该行里的字符偏移」也算出来 —— :793 的 rowHead 分支靠它精确定位
              var rowOff = -1
              try {
                var rowText0 = (rowEl !== null && rowEl !== undefined) ? String(rowEl.textContent || '') : ''
                var sp0 = allNormSpans(rowText0, txt)
                if (sp0 !== null && sp0.length > 0) rowOff = sp0[0].start
              } catch (_o) { rowOff = -1 }
              block.push({
                id: 'R|' + txt, text: txt, note: String(it.note || ''), pending: false,
                seqKey: rowKey, rowHead: rowHead, textOffset: rowOff,
              })
            }
          }
          if (block.length > 0) {
            // decorateAll 从**最新**的消息往下扫，所以每批往前拼 → 最终顺序＝最老的在前（编号 1、2、3…）
            restoredItems = block.concat(restoredItems)
            markersSig = null        // 签名作废：下面立刻按新清单重画一次
            renderMarkers()
          }
        } catch (_) { /* 忽略 */ }
      }
      function buildMarkers() {
        var markerList = markerListFor()
        if (markerList.length === 0) return
        var placed = []
        for (var i = 0; i < markerList.length; i++) {
          var q = markerList[i]
          var range = locateQuote(q.text, q)
          if (range === null) continue
          var rects = quoteRects(range, q)
          for (var c = 0; c < rects.length; c++) {
            var rect = rects[c]
            if (rect.width === 0 || rect.height === 0) continue
            var hl = document.createElement('div')
            hl.className = 'dsh-ann-hl'
            hl.setAttribute('data-ann-index', String(i + 1))
            hl.setAttribute('data-ann-text', String(q.text || ''))   // 隐藏判定按文字，不按会错位的下标（2026-10-16）
            hl.style.left = rect.left + 'px'
            hl.style.top = rect.top + 'px'
            hl.style.width = rect.width + 'px'
            hl.style.height = rect.height + 'px'
            overlay.appendChild(hl)
          }
          var anchor = null
          for (var k = 0; k < rects.length; k++) {
            var r = rects[k]
            if (r.width === 0 || r.height === 0) continue
            if (r.top > -8 && r.top < window.innerHeight) { anchor = r; break }
          }
          if (anchor === null && rects.length > 0 && rects[0].width > 0) anchor = rects[0]
          if (anchor !== null) {
            // 2026-10-16 用户点名「这个偏移能取消吗」——编号原来固定摆在原文**上方 20px**，
            // 结果它飘在上下两行之间、跟标注的那行对不齐（截图实测：编号 y=154..177，
            // 它标注的高亮框 y=183..218）。改成**跟原文那一行垂直居中**。
            var chipH = 16
            var lineH = anchor.height > 28 ? 28 : anchor.height   // 多行选区只对齐第一行
            var chipTop = Math.round(anchor.top + (lineH - chipH) / 2)
            if (chipTop < 4) chipTop = 4
            if (chipTop + chipH > window.innerHeight - 4) chipTop = Math.max(4, window.innerHeight - 4 - chipH)
            // 2026-10-16 本地升级：不再把编号钳回正文区上沿 —— 编号跟着原文走，
            // 滚动经过标题栏区域时仍然可见（只避让输入区，见下方 blockers）。
            // 编号现在跟正文同一行了，横向必须让开第一个字 → 挪进左边距。
            var chipLeft = Math.max(4, Math.min(anchor.left - 26, window.innerWidth - 24))
            // 编号只允许出现在「会话正文实际看得见」的地方：跟正文一样，滚出
            // 内容可视区就消失，绝不贴边钉住（钉住会浮在输入框上/下面的空处）。
            // 两条判据：① 落在正文滚动容器里；② 不与宿主遮挡 UI（会话头部、
            // 整块输入区）相交。任一不满足就整条不渲染——不渲染也就不会出现
            // 被裁掉半截的"阴影残影"。
            var skipChip = false
            var views = hostLocalRects('scrollBody')
            for (var vc = 0; vc < views.length; vc++) {
              var vr = views[vc]
              if (chipLeft + 26 <= vr.left || chipLeft >= vr.right) continue
              if (chipTop < vr.top || chipTop + 18 > vr.bottom) skipChip = true
              break
            }
            // 同上：只避让输入区，不再因为"落在会话头部"就整条不渲染编号。
            var blockers = hostComposerRects()
            for (var bc = 0; bc < blockers.length && !skipChip; bc++) {
              var bk = blockers[bc]
              if (chipLeft + 26 <= bk.left || chipLeft >= bk.right) continue
              if (chipTop + 18 > bk.top && chipTop < bk.bottom) skipChip = true
            }
            if (!skipChip) {
              var chip = document.createElement('div')
              chip.className = 'dsh-ann-num'
              chip.setAttribute('data-ann-index', String(i + 1))
              chip.setAttribute('data-ann-text', String(q.text || ''))   // 隐藏判定按文字，不按会错位的下标（2026-10-16）
              chip.textContent = String(i + 1)
              var tries = 0
              while (tries < 12) {
                var clash = false
                for (var p = 0; p < placed.length; p++) {
                  var bp = placed[p]
                  if (Math.abs(bp.left - chipLeft) < 18 && Math.abs(bp.top - chipTop) < 18) {
                    clash = true
                    break
                  }
                }
                if (!clash) break
                chipLeft += 18
                if (chipLeft > window.innerWidth - 24) { chipLeft = 4; chipTop += 18 }
                tries++
              }
              placed.push({ left: chipLeft, top: chipTop })
              chip.style.left = chipLeft + 'px'
              chip.style.top = chipTop + 'px'
              ;(function (q) {
                chip.addEventListener('click', function (ev) {
                  ev.stopPropagation()
                  openEditorFor(q)
                })
              })(q)
              numLayer.appendChild(chip)
            }
          }
        }
      }

      // ---------- 动作 ----------
      function captureAnchor(text) {
        var anchor = {
          range: null, seqKey: '', rowHead: '', textOffset: -1,
          ctxBefore: '', ctxAfter: '',
        }
        try {
          var sel = window.getSelection()
          if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return anchor
          var live = sel.getRangeAt(0)
          var liveText = live.toString()
          // 选区文本与 settle 快照一致才持有 live range；不一致（选区微变、DOM
          // 被批注芯片等装饰改写）时也绝不返回全空锚——尽力抓行级锚点
          // （seqKey/rowHead），让 locateQuote 在锚点消息内宽松重定位。
          var textMatch = liveText.trim() === text
            || liveText.trim().replace(/\s+/g, ' ') === text.replace(/\s+/g, ' ')
          if (textMatch) {
            anchor.range = live.cloneRange()
          }
          var source = documentSourceOf(live.commonAncestorContainer)
          if (source !== null) {
            anchor.sourceUrl = source.sourceUrl
            anchor.sourcePath = source.sourcePath
            anchor.textOffset = offsetOfRangeInRow(source.root, live) + liveText.indexOf(text)
            return anchor
          }
          var node = live.commonAncestorContainer
          var el = node instanceof Element ? node : (node !== null ? node.parentElement : null)
          // 主视图锚 key 为 data-chat-anchor-key；focus-chat 视图为
          // data-focus-anchor-key，两者等价（消息 seq 锚定）。
          while (el !== null && el !== document.body
            && !el.hasAttribute('data-chat-anchor-key')
            && !el.hasAttribute('data-focus-anchor-key')) {
            el = el.parentElement
          }
          if (el !== null
            && (el.hasAttribute('data-chat-anchor-key') || el.hasAttribute('data-focus-anchor-key'))) {
            anchor.seqKey = el.getAttribute('data-chat-anchor-key')
              || el.getAttribute('data-focus-anchor-key') || ''
            if (textMatch) {
              var itemText = el.textContent || ''
              var realOff = offsetOfRangeInRow(el, live)
              if (realOff >= 0) {
                anchor.textOffset = realOff
                anchor.ctxBefore = itemText.slice(Math.max(0, realOff - 24), realOff)
                anchor.ctxAfter = itemText.slice(realOff + text.length, realOff + text.length + 24)
              }
            }
          }
          var row = assistantRowOf(live.commonAncestorContainer)
          if (row !== null) {
            anchor.rowHead = (row.textContent || '').slice(0, 24)
          }
        } catch (_) { /* 抓取失败则保持空锚 */ }
        return anchor
      }

      function enterEditing() {
        ui.mode = 'editing'
        ui.noteDraft = ''
        ui.error = null
        ui.editingId = null
        ui.pendingAnchor = captureAnchor(ui.quote)
        render()
      }

      /** 点击角标数字 → 重新打开该批注的编辑面板（预填批注内容，可修改后保存）。 */
      function openEditorFor(q) {
        ui.mode = 'editing'
        ui.quote = q.text
        ui.source = q
        ui.noteDraft = q.note !== undefined ? q.note : ''
        ui.error = null
        ui.editingId = q.id
        ui.pendingAnchor = null
        var range = locateQuote(q.text, q)
        var rect = range !== null ? range.getBoundingClientRect() : null
        ui.pos = rect !== null && rect.width > 0
          ? placeAbove(rect, 40)
          : { left: 8, top: 8 }
        render()
      }

      /** 组装批注块；只有附带正文时才添加「提问：」分隔标记。 */
      function buildBlock(hasQuestion) {
        var n = ui.quotes.length
        var parts = ui.quotes.map(function (q, i) {
          var s = (i + 1) + '. ' + quoteWithSource(q).replace(/\n/g, '\n   ')
          if (q.note !== undefined && q.note.trim() !== '') {
            s += '\n   ' + t('block.notePrefix') + q.note.replace(/\n/g, '\n    ')
          }
          return s
        })
        return t(hasQuestion ? 'block.head' : 'block.headOnly', { n: n }) + '\n\n'
          + parts.join('\n\n')
          + '\n\n' + t(hasQuestion ? 'block.format' : 'block.formatOnly', { n: n })
          + (hasQuestion ? '\n\n' + t('block.marker') : '')
      }

      function shouldAttachForEnter(e, draft) {
        return !(e.ctrlKey || e.metaKey) || draft.trim() === ''
      }

      /** 裸斜杠开头的草稿按宿主约定是命令（/goal、/model 等）：
       *  宿主输入机靠「草稿以命令 token 开头」维持命令声明。 */
      function isCommandDraft(draft) {
        return draft.trimStart().charAt(0) === '/'
      }

      /** 合成结束后的保护窗只拦住原本会携带批注的提交。
       *  原生合成信号仍交给宿主编辑器，草稿读取不改动合成文本。 */
      function shouldGuardImeEnter(e) {
        if (imeClearTimer === null || e.isComposing === true || e.keyCode === 229) return false
        var current = readCurrentSessionId()
        if (current === undefined) return false
        try {
          var scoped = sessions.scope(current)
          if (scoped === undefined) return false
          var draft = ctx.conversation.input.for(scoped).state.getSnapshot().draft || ''
          return shouldAttachForEnter(e, draft) && !isCommandDraft(draft)
        } catch (_) { return false }
      }

      /** 提交前把批注块拼进 composer 草稿（随回车一起发送）。
       *  返回 true 表示批注块已在草稿中（本次刚拼入，或之前已拼入未发送）。 */
      function attachAndSend(e) {
        var current = readCurrentSessionId()
        if (current === undefined) {
          console.warn('[annotation] 无法确定当前会话，批注未拼入草稿')
          showToast(t('toast.noSession'))
          return false
        }
        try {
          var scoped = sessions.scope(current)
          if (scoped === undefined) {
            console.warn('[annotation] 当前会话 scope 不可用，批注未拼入草稿')
            showToast(t('toast.noSession'))
            return false
          }
          var shell = ctx.conversation.input.for(scoped)
          var st = shell.state.getSnapshot()
          var draft = st.draft || ''
          if (!shouldAttachForEnter(e, draft)) return false
          // 斜杠命令不拼批注（issue #20）：批注块前置会破坏命令 token 前缀，
          // 宿主 watchClaim 释放声明后 /goal 被降级为普通消息；后置追加则会
          // 把块原样并入命令参数。命令草稿原样放行，批注保留待下一条消息。
          if (isCommandDraft(draft)) {
            showToast(t('toast.skipCommand'))
            return false
          }
          // 草稿已含批注块（上次追加未发送）→ 不重复追加（zh/en 双哨兵）。
          if (hasAnnotationBlock(draft)) {
            annotationAttached = true
            return true
          }
          var hasQuestion = draft.trim() !== ''
          var block = buildBlock(hasQuestion)
          shell.setDraft(block + (hasQuestion ? '\n' + draft : ''))
          annotationAttached = true
          console.log('[annotation] 批注块已拼入草稿，回车将随消息发送（' + ui.quotes.length + ' 条）')
          return true
        } catch (err) {
          console.warn('[annotation] 批注拼稿失败：', err)
          showToast(t('toast.attachFail') + (err && err.message ? err.message : err))
          return false
        }
      }

      // 批注保存/删除完成后把焦点还给 composer 输入框（光标在末尾），
      // 用户可直接回车发送，无需再点一下输入框。
      // preventScroll：长会话中选中文字时输入框可能在视口外，默认 focus
      // 会强制滚动页面（视觉上"卡一下"）；延迟一帧让卡片关闭动画先完成，
      // 焦点回归更平滑。
      function focusComposer() {
        var input = document.querySelector('[data-composer-card] [data-composer-input]')
        if (!(input instanceof HTMLElement) || !input.isContentEditable) return
        requestAnimationFrame(function () {
          if (!input.isConnected) return
          input.focus({ preventScroll: true })
          var selection = window.getSelection()
          if (selection !== null) {
            selection.selectAllChildren(input)
            selection.collapseToEnd()
          }
        })
      }

      function saveAnnotation() {
        var text = ui.quote
        if (text === '') { ui.error = t('error.noSelection'); render(); return }
        var note = ui.noteDraft.trim()
        // 编辑已有批注（点击角标进入）：按 id 更新批注内容。
        if (ui.editingId !== null) {
          for (var ei = 0; ei < ui.quotes.length; ei++) {
            if (ui.quotes[ei].id === ui.editingId) {
              ui.quotes[ei].note = note
              ui.editingId = null
              ui.pendingAnchor = null
              ui.noteDraft = ''
              ui.error = null
              writeCurrentPendingQuotes()
              closeToolbar()
              updateChip()
              renderMarkers()
              focusComposer()
              return
            }
          }
          ui.editingId = null
        }
        if (!ui.quotes.some(function (q) { return q.text === text && (q.sourceUrl || '') === (ui.pendingAnchor && ui.pendingAnchor.sourceUrl || '') })) {
          var a = ui.pendingAnchor || { range: null, seqKey: '', rowHead: '', textOffset: -1, ctxBefore: '', ctxAfter: '' }
          ui.quotes.push({
            id: 'q-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
            text: text,
            note: note,
            range: a.range,
            ...(a.sourceUrl ? { sourceUrl: a.sourceUrl, sourcePath: a.sourcePath } : {}),
            seqKey: a.seqKey,
            rowHead: a.rowHead,
            textOffset: a.textOffset,
            ctxBefore: a.ctxBefore,
            ctxAfter: a.ctxAfter,
          })
        }
        writeCurrentPendingQuotes()
        ui.pendingAnchor = null
        ui.noteDraft = ''
        ui.error = null
        closeToolbar()
        updateChip()
        renderMarkers()
        focusComposer()
      }

      function removeQuote(id) {
        ui.quotes = ui.quotes.filter(function (q) { return q.id !== id })
        writeCurrentPendingQuotes()
        updateChip()
        render()
        renderMarkers()
        // 面板正在显示时同步重建：否则删掉的条目还留在面板里，必须重新 hover 才消失。
        if (tipOwner === chipLayer) showChipTip()
      }

      function closeToolbar() {
        if (ui.mode === 'closed') return
        clearSettle()
        ui.mode = 'closed'
        ui.error = null
        ui.busy = false
        ui.lastKey = ''
        ui.editingId = null
        render()
      }

      // ---------- 输入框旁的批注标签（N 条批注 · 悬浮看全部内容） ----------
      var chipLayer = document.createElement('div')
      chipLayer.setAttribute('data-annotation-chip', '')
      chipLayer.style.cssText = 'position:fixed;z-index:1150;display:none;align-items:center;gap:4px;height:24px;padding:0 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #2c2c2e));box-shadow:var(--dsw-shadow-lv3);font-family:var(--dsw-font-family,system-ui);font-size:12px;color:var(--dsw-alias-label-primary);cursor:default;animation:dsh-ann-pop .12s var(--ds-ease-in-out, ease);'
      document.body.appendChild(chipLayer)
      var tipLayer = document.createElement('div')
      tipLayer.setAttribute('data-annotation-tip-layer', '')
      document.body.appendChild(tipLayer)
      // tipLayer 是三类悬浮面板（输入框胶囊 / 气泡标签 / 回复芯片）共享的单例容器。
      // 记录当前面板的归属元素：任何清空都必须指名归属，无归属清空会误杀用户
      // 正在观看的面板——宿主 layout mutation 会高频触发 updateChip，面板刚显示
      // 就被抹掉（表现为「芯片显示内容后直接消失」）。
      var tipOwner = null
      function clearTip(owner) {
        if (owner !== undefined && tipOwner !== owner) return
        tipLayer.textContent = ''
        tipOwner = null
      }
      function presentTip(owner, el) {
        tipLayer.textContent = ''
        tipLayer.appendChild(el)
        tipOwner = owner
      }
      // 共享容器的监听器只注册一次（sharedTipMouseEnter / sharedTipMouseLeave）。
      // 气泡标签与回复芯片会被反复重建：原先每个面板在 mouseenter 里都往共享容器
      // 追加一对监听器却从不移除，每重建一代净增两个闭包（持有已废弃的 grace 定时器
      // 与被移出 DOM 的触发元素）。这里改为两处固定监听器 + 一个「当前面板的关闭钩子」
      // 指针（tipActiveHide），由面板在 mouseenter 时登记，真正关闭后解除。
      var tipActiveHide = null
      function sharedTipMouseEnter() {
        if (tipActiveHide === null) return
        tipActiveHide.keep()
      }
      function sharedTipMouseLeave() {
        if (tipActiveHide === null) return
        tipActiveHide.hide()
      }
      tipLayer.addEventListener('mouseenter', sharedTipMouseEnter)
      tipLayer.addEventListener('mouseleave', sharedTipMouseLeave)
      var observedComposer = null
      var composerObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(onLayoutChange)
        : null

      /** 待发送胶囊必须让开整个输入区：队列的「立即发送」按钮在卡片上方
       *  的 dock 内（#60）。优先稳定的 data hook，旧宿主认完整 CSS local，
       *  不能误中 composerSeatInner；没有 seat 的宿主仍以输入卡片为锚。 */
      function composerSeatOf(card) {
        var seat = card.closest('[data-composer-seat]')
        if (seat !== null) return seat
        for (var el = card.parentElement; el !== null; el = el.parentElement) {
          if (/(^|\s)\S*_composerSeat(\s|$)/.test(el.getAttribute('class') || '')) return el
        }
        return card
      }

      function updateChip() {
        if (ui.quotes.length === 0) {
          chipLayer.style.display = 'none'
          clearTip(chipLayer)
          return
        }
        chipLayer.textContent = ''
        var b = document.createElement('b')
        b.style.cssText = 'color:var(--dsw-alias-text-accent,#4c9aff);font-weight:700;'
        b.textContent = String(ui.quotes.length)
        chipLayer.appendChild(b)
        chipLayer.appendChild(document.createTextNode(plural('chip.count', ui.quotes.length)))
        var card = document.querySelector('[data-composer-card]')
        var seat = card === null ? null : composerSeatOf(card)
        if (seat !== observedComposer) {
          if (composerObserver !== null) composerObserver.disconnect()
          observedComposer = seat
          // 队列增加/展开时卡片尺寸可能完全不变，要观察包含 dock 的 seat。
          if (composerObserver !== null && seat !== null) composerObserver.observe(seat)
        }
        if (card === null) {
          chipLayer.style.display = 'none'
          clearTip(chipLayer)
          return
        }
        var r = card.getBoundingClientRect()
        if (r.width === 0 || r.height === 0 || r.right <= 0 || r.bottom <= 0
          || r.left >= window.innerWidth || r.top >= window.innerHeight) {
          chipLayer.style.display = 'none'
          clearTip(chipLayer)
          return
        }
        // display:none 时 offsetWidth 为 0；先显示再量，首帧也能正确对齐长文案。
        chipLayer.style.display = 'flex'
        var w = chipLayer.offsetWidth || 80
        var h = chipLayer.offsetHeight || 24
        var top = Math.min(r.top, seat.getBoundingClientRect().top) - h - 6
        // 不能把胶囊钳回 seat 内而遮住队列控件；空间恢复后下一次布局刷新会重显。
        if (top < 8) {
          chipLayer.style.display = 'none'
          clearTip(chipLayer)
          return
        }
        chipLayer.style.left = Math.max(8, Math.min(r.right - w - 12, window.innerWidth - w - 8)) + 'px'
        chipLayer.style.top = top + 'px'
      }

      // 悬停宽限：标签与面板间有间隙，鼠标跨越间隙的瞬间不在任何元素上——
      // 离开后给 250ms 宽限期，期间进入面板则取消关闭（官方 HoverCard 的
      // pointer-grace 同款思路），同时杜绝闪烁循环。
      //
      // 但固定 250ms 只是「赌手快」：面板定位是 r.bottom + 6 或 r.top - h - 6，
      // 与触发元素之间有 6px 间隙，指针停在间隙里把宽限走满，面板照样消失；
      // 触摸板细调或系统卡顿更容易命中。这里改成确定性判定：宽限到点时复查
      // **实时**指针位置，只要还在「触发元素 + 面板 + 间隙容差」的并集内就不关闭。
      //
      // 必须用实时坐标：mouseleave 事件的 clientX/clientY 是离开那一刻的，
      // 250ms 后再拿它判断会读到过期位置，等于没判。
      var TIP_GAP_TOLERANCE = 10
      var livePointerX = null
      var livePointerY = null
      function onTipPointerMove(e) {
        livePointerX = e.clientX
        livePointerY = e.clientY
      }
      document.addEventListener('pointermove', onTipPointerMove, true)
      function pointerInsideRect(r) {
        if (r === undefined || r === null) return false
        if (livePointerX === null || livePointerY === null) return false
        return livePointerX >= r.left - TIP_GAP_TOLERANCE && livePointerX <= r.right + TIP_GAP_TOLERANCE
          && livePointerY >= r.top - TIP_GAP_TOLERANCE && livePointerY <= r.bottom + TIP_GAP_TOLERANCE
      }
      /** 实时指针是否仍在任一已展开面板内（含间隙容差）。 */
      function pointerWithinTipLayer() {
        for (var i = 0; i < tipLayer.childNodes.length; i++) {
          var node = tipLayer.childNodes[i]
          if (node.nodeType !== 1 || typeof node.getBoundingClientRect !== 'function') continue
          if (pointerInsideRect(node.getBoundingClientRect())) return true
        }
        return false
      }
      /** 关不关面板的统一判据：指针还在面板上或触发元素上就保持展开。 */
      function shouldKeepTipOpen(trigger) {
        if (pointerWithinTipLayer()) return true
        if (trigger === undefined || trigger === null) return false
        if (typeof trigger.getBoundingClientRect !== 'function') return false
        return pointerInsideRect(trigger.getBoundingClientRect())
      }
      var hoverGrace = null
      // 触发元素由调用方传入：面板留在 DOM 里时指针常常停在触发元素上
      // （还没移进面板），只判面板矩形会误关。
      function scheduleHide(trigger) {
        if (hoverGrace !== null) clearTimeout(hoverGrace)
        hoverGrace = setTimeout(function () {
          hoverGrace = null
          if (shouldKeepTipOpen(trigger)) return
          releaseActiveTip()
          clearTip(chipLayer)
        }, 250)
      }
      function cancelHide() {
        if (hoverGrace !== null) { clearTimeout(hoverGrace); hoverGrace = null }
      }
      /** 面板已真正关闭时解除登记：此后共享容器上的 mouseenter/leave 不再有对象可派发。 */
      function releaseActiveTip() {
        tipActiveHide = null
      }
      chipLayer.addEventListener('mouseenter', function () {
        cancelHide()
        showChipTip()
        tipActiveHide = { keep: cancelHide, hide: function () { scheduleHide(chipLayer) } }
      })
      chipLayer.addEventListener('mouseleave', function () { scheduleHide(chipLayer) })

      // B1（2026-10-17）：同一个「批注浮层」原本被写了两份（chip 提示 / 气泡标签提示），抽成这一处。
      // 只搬结构、不改字面量：两份的 cssText 与文案 key 原样保留，因此外观零变化。
      var ANN_TIP_BOX_CSS = 'position:fixed;z-index:1160;box-sizing:border-box;width:300px;max-width:calc(100vw - 16px);padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #2c2c2e));box-shadow:var(--dsw-shadow-lv3);font-family:var(--dsw-font-family,system-ui);font-size:12px;color:var(--dsw-alias-label-primary);'
      var ANN_TIP_NUM_CSS = 'display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;margin-right:6px;border-radius:9px;background:var(--dsw-alias-text-accent,#4c9aff);color:#fff;font-size:12px;font-weight:700;'
      function buildAnnTip(opts) {
        var list = (opts && opts.items) || []
        var el = document.createElement('div')
        el.className = 'dsh-ann-tip'
        el.style.cssText = ANN_TIP_BOX_CSS
        var head = document.createElement('div')
        head.style.cssText = 'font-weight:600;margin-bottom:6px;'
        head.textContent = t(opts.titleKey, { n: list.length })
        el.appendChild(head)
        for (var i = 0; i < list.length; i++) {
          var it = list[i]
          var item = document.createElement('div')
          item.style.cssText = 'padding:6px 0;border-top:1px solid var(--dsw-alias-border-strong,#444);'
          var num = document.createElement('span')
          num.style.cssText = ANN_TIP_NUM_CSS
          num.textContent = String(i + 1)
          var body = document.createElement('span')
          body.style.cssText = 'font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);'
          body.textContent = opts.textOf(it, i)
          item.appendChild(num)
          item.appendChild(body)
          var nt = opts.noteOf ? opts.noteOf(it, i) : ''
          if (nt) {
            var note = document.createElement('div')
            note.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary);margin:2px 0 0 22px;word-break:break-word;'
            note.textContent = t('tip.notePrefix') + truncate(nt, 60)
            item.appendChild(note)
          }
          if (opts.onDelete) {
            var del = document.createElement('button')
            del.type = 'button'
            del.textContent = t('tip.del')
            del.style.cssText = 'margin-left:8px;background:transparent;border:1px solid rgba(255,107,107,.4);color:#ff8a8a;border-radius:6px;font-size:12px;cursor:pointer;padding:7px 10px;'
            ;(function (one) {
              del.addEventListener('click', function (ev) {
                ev.stopPropagation()
                opts.onDelete(one)
              })
            })(it)
            item.appendChild(del)
          }
          el.appendChild(item)
        }
        return el
      }

      function showChipTip() {
        if (ui.quotes.length === 0) return
        var el = buildAnnTip({
          titleKey: 'tip.title',
          items: ui.quotes,
          textOf: function (q) { return truncate(quoteWithSource(q), 100) },
          noteOf: function (q) { return (q.note !== undefined && q.note.trim() !== '') ? q.note : '' },
          onDelete: function (q) { removeQuote(q.id) }
        })
        presentTip(chipLayer, el)
        var r2 = chipLayer.getBoundingClientRect()
        var w2 = 300
        var gap = 8
        // 浮窗只允许出现在正文可见区里（避开会话头部与整块输入区）：批注条数多
        // 时先把它限制在这个高度内、内部滚动——否则十来个批注会把浮窗顶出屏幕
        // 或压到输入框上，看起来就是"浮窗显示错乱"。
        var topLimit = gap
        var heads = hostHeaderRects()
        for (var hi = 0; hi < heads.length; hi++) {
          if (r2.left + w2 <= heads[hi].left || r2.left >= heads[hi].right) continue
          if (heads[hi].bottom + gap > topLimit) topLimit = heads[hi].bottom + gap
        }
        var bottomLimit = window.innerHeight - gap
        var seats = hostComposerRects()
        for (var si = 0; si < seats.length; si++) {
          if (r2.left + w2 <= seats[si].left || r2.left >= seats[si].right) continue
          if (seats[si].top - gap < bottomLimit) bottomLimit = seats[si].top - gap
        }
        var room = Math.round(r2.top - gap - topLimit)
        if (room < 120) room = Math.round(bottomLimit - r2.bottom - gap)
        room = Math.max(80, room)
        el.style.maxHeight = room + 'px'
        el.style.overflowY = 'auto'
        var h2 = Math.min(el.offsetHeight || 120, room)
        var top = r2.top - h2 - gap
        if (top < topLimit) top = r2.bottom + gap
        if (top + h2 > bottomLimit) top = bottomLimit - h2
        el.style.left = Math.max(8, Math.min(r2.left, window.innerWidth - w2 - 8)) + 'px'
        el.style.top = Math.round(Math.max(topLimit, top)) + 'px'
        el.style.width = w2 + 'px'
      }

      // ---------- 发送完成监听（草稿从有内容变空 → 清空批注集） ----------
      var inputUnsub = null
      // 仅当批注块真正拼入过草稿（用户按过回车）才在草稿清空时清除批注，
      // 避免普通草稿编辑（打字后删字）误触发「已发送」判定而清空批注集。
      var annotationAttached = false
      var inputWatchTimer = null
      function tryWatchInputDraft(id) {
        try {
          var sc = sessions.scope(id)
          if (sc === undefined) return false
          var sh = ctx.conversation.input.for(sc)
          if (sh === undefined || sh === null || typeof sh.state.subscribe !== 'function') return false
          var hadDraft = false
          inputUnsub = sh.state.subscribe(function () {
            var d = (sh.state.getSnapshot().draft || '').trim()
            var wasHad = hadDraft
            hadDraft = d !== ''
            if (ui.quotes.length === 0) return
            // 发送完成：草稿从有内容变空 → 脚标消失、编号下次从 1 开始；
            // 同时在刚发出的用户消息气泡上贴「N 条批注」标签。
            if (wasHad && d === '' && annotationAttached) {
              var sentItems = ui.quotes.map(function (q) {
                return { text: quoteWithSource(q), note: q.note || '' }
              })
              ui.quotes = []
              annotationAttached = false
              writeCurrentPendingQuotes()
              clearTip(chipLayer)
              updateChip()
              renderMarkers()
              pendingDeco.push({ items: sentItems })
              kickDecorate()
            }
          })
          return true
        } catch (_) { inputUnsub = null; return false }
      }
      // 发送清空只认这里的「草稿有→空」迁移（装饰扫描不再兜底，见 decorateAll）。
      // 插件可能先于会话加载完成：current 未定、scope/input 尚不可用时订阅会失败，
      // 必须每秒重试直到挂上，否则一次发送的清空被漏掉，已发送的批注会永远留在
      // 待发送集里，之后每次 Enter 都重新拼进草稿。
      function watchInputDraft() {
        if (inputWatchTimer !== null) { clearInterval(inputWatchTimer); inputWatchTimer = null }
        if (typeof inputUnsub === 'function') { inputUnsub(); inputUnsub = null }
        // 会话切换时旧 scope 的订阅由上层先释放，这里只负责挂上当前会话；
        // 切换后若 scope 尚不可用，仍靠下方的 1s 重试补齐（同 watchInputDraft 原有语义）。
        // 注意：切换后必须重新订阅新会话的草稿，否则“草稿有→空”的发送清空权威会
        // 继续监听旧会话，新会话发送后待发送批注永远不清（每次 Enter 重复拼稿）。
        var id = readCurrentSessionId()
        if (id !== undefined && tryWatchInputDraft(id)) return
        inputWatchTimer = setInterval(function () {
          var cur = readCurrentSessionId()
          if (cur !== undefined && tryWatchInputDraft(cur)) {
            clearInterval(inputWatchTimer)
            inputWatchTimer = null
          }
        }, 1000)
      }

      /** 把批注块文本从用户消息气泡里藏掉（模型消息内容不受影响）：
       *  用户气泡是纯文本渲染（MessageText，单个文本节点），
       *  找到最后一个「\n提问：」（老格式回退「\n问题：」），
       *  保留其后的用户问题，整块批注文本从 DOM 移除。
       *  返回是否成功（内容未渲染完时返回 false，轮询稍后重试）。 */
      function hideAnnotationBlock(row) {
        try {
          var bubble = row.querySelector('[class*="bubble"]')
          if (bubble === null) return false
          var nodes = []
          var full = ''
          var walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT)
          var n
          while ((n = walker.nextNode()) !== null) {
            nodes.push(n)
            full += n.nodeValue || ''
          }
          // 纯批注用完整首尾文案识别，避免原文中的「提问：」被误当成正文分隔符。
          // 语言列表取自词典本身：多一种语言（ru）就自动多一条识别路径。
          var annotationOnly = Object.keys(STR).some(function (lang) {
            return full.indexOf(dictVal(lang, 'block.headOnly')) === 0
              && full.trimEnd().endsWith(dictVal(lang, 'block.formatOnly'))
          })
          if (annotationOnly) {
            nodes.forEach(function (node) { node.nodeValue = '' })
            return true
          }
          // 标记定位：当前语言优先（zh「提问：」/ en「Ask:」，均先带「\n」再裸匹配），
          // 另兼容另一语言与「问题：」老格式，保证历史消息跨语言切换可解析。
          var markers = blockMarkers()
          var marker = -1
          var markerStr = ''
          for (var p = 0; p < markers.length && marker === -1; p++) {
            var idx = full.lastIndexOf(markers[p])
            if (idx !== -1) { marker = idx; markerStr = markers[p] }
          }
          if (marker === -1) return false
          // 连同分隔标记一起切掉，保留其后的问题。
          var skip = markerStr.length
          // 定位到具体文本节点。
          var pos = 0
          var ti = -1
          var inner = 0
          for (var j = 0; j < nodes.length; j++) {
            var len = (nodes[j].nodeValue || '').length
            if (marker < pos + len) { ti = j; inner = marker - pos; break }
            pos += len
          }
          if (ti === -1) return false
          // 去掉标记及其前的所有内容，保留其后的问题。
          nodes[ti].nodeValue = (nodes[ti].nodeValue || '').slice(inner + skip).replace(/^\s+/, '')
          for (var m2 = ti - 1; m2 >= 0; m2--) {
            if (nodes[m2].parentNode !== null) nodes[m2].parentNode.removeChild(nodes[m2])
          }
          // 清理空元素。
          var empties = bubble.querySelectorAll('div,span,p')
          for (var e = 0; e < empties.length; e++) {
            var em = empties[e]
            if (em.parentNode !== null && (em.textContent || '').trim() === '') em.remove()
          }
          return true
        } catch (err) {
          console.warn('[annotation] 气泡隐藏手术失败：', err)
          return false
        }
      }

      /** 从气泡文本反解析批注条目（用于刷新后旧消息的 hover 内容）。 */
      function parseItemsFromBubble(row) {
        try {
          var b = row.querySelector('[class*="bubble"]')
          var text = (b ? b.textContent : '') || ''
          var mi = -1
          for (var mk = 0; mk < PARSE_MARKERS.length; mk++) {
            var pmi = text.lastIndexOf(PARSE_MARKERS[mk])
            if (pmi > mi) mi = pmi
          }
          if (mi !== -1) text = text.slice(0, mi)
          var nl = text.indexOf('\n\n')
          var body = nl === -1 ? '' : text.slice(nl + 2)
          var out = []
          var parts = body.split('\n\n')
          for (var i = 0; i < parts.length; i++) {
            var mm = /^(\d+)\.\s*([\s\S]*)$/.exec(parts[i])
            if (mm === null) continue
            var item = mm[2]
            var note = ''
            var nm = /\n\s*(?:批注：|Note:|Примечание:)\s*([\s\S]*)$/.exec(item)
            if (nm !== null) { note = nm[1].trim(); item = item.slice(0, nm.index) }
            out.push({ text: item.replace(/\n   /g, '\n').trim(), note: note })
          }
          return out
        } catch (_) { return [] }
      }

      /** 在用户气泡上贴「批注 ×N」标签（hover 显示条目内容）。 */
      function attachBubbleTag(row, items) {
        if (row.querySelector('[data-annotation-bubble-tag]') !== null) return
        var bubble = row.querySelector('[class*="bubble"]') || row
        var tag = document.createElement('span')
        tag.setAttribute('data-annotation-bubble-tag', '')
        tag.textContent = t('bubble.tag', { n: items.length })
        tag.style.cssText = 'display:inline-flex;align-items:center;height:20px;padding:0 8px;margin:4px 0 0 4px;border-radius:10px;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #2c2c2e));color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family,system-ui);font-size:12px;cursor:default;'
        ;(function (list) {
          tag.addEventListener('mouseenter', function () {
            tipActiveHide = { keep: bubbleKeep, hide: bubbleHide }
            var el = buildAnnTip({
              titleKey: 'bubble.title',
              items: list,
              textOf: function (it) { return truncate(it.text, 50) },
              noteOf: function (it) { return it.note !== '' ? it.note : '' }
            })
            presentTip(tag, el)
            var r2 = tag.getBoundingClientRect()
            var w2 = 300
            var h2 = el.offsetHeight || 120
            var left = Math.max(8, Math.min(r2.left, window.innerWidth - w2 - 8))
            var top = r2.bottom + 6
            if (top + h2 > window.innerHeight - 8) top = r2.top - h2 - 6
            el.style.left = left + 'px'
            el.style.top = Math.max(8, top) + 'px'
            el.style.width = w2 + 'px'
          })
          var bubbleGrace = null
          function bubbleHide() {
            if (bubbleGrace !== null) clearTimeout(bubbleGrace)
            bubbleGrace = setTimeout(function () {
              bubbleGrace = null
              if (shouldKeepTipOpen(tag)) return
              releaseActiveTip()
              clearTip(tag)
            }, 250)
          }
          function bubbleKeep() {
            if (bubbleGrace !== null) { clearTimeout(bubbleGrace); bubbleGrace = null }
          }
          // 只登记关闭钩子，不再往共享 tipLayer 上追加监听器（见 tipActiveHide 注释）
          tag.addEventListener('mouseleave', bubbleHide)
        })(items)
        tag.__annotationItems = items
        bubble.appendChild(tag)
        console.log('[annotation] 气泡已贴批注标签 ×' + items.length)
      }

      /** 发送完成时暂存批注数据（供气泡 hover 面板使用）。 */
      var pendingDeco = []

      // ---------- 助手回复中的「Annotation N：」→ 悬浮批注芯片 ----------

      /** 找到该回复行之前最近一条携带批注标签的用户消息的条目数据。 */
      function findPrevAnnotationItems(row) {
        var rows = allMessageRows()
        var idx = rows.indexOf(row)
        if (idx === -1) return null
        for (var i = idx - 1; i >= 0; i--) {
          var tag = rows[i].querySelector('[data-annotation-bubble-tag]')
          if (tag !== null && Array.isArray(tag.__annotationItems) && tag.__annotationItems.length > 0) {
            return tag.__annotationItems
          }
        }
        return null
      }

      /** 扫描所有已结束流式输出的助手行：把「Annotation N：」替换为可悬浮芯片。 */
      /** 流式 mutation 批次的芯片装饰限流: 前导 + 500ms 拖尾, 每批次最多触发一次
       *  增量扫描(只扫助手行), 代替逐批全文档 decorateAll。 */
      var lastAssistantDecorate = 0
      var assistantDecorateTimer = null
      function scheduleAssistantDecorate() {
        var now = performance.now()
        if (now - lastAssistantDecorate >= 500) {
          lastAssistantDecorate = now
          decorateAssistantAnnotations()
          return
        }
        if (assistantDecorateTimer !== null) return
        assistantDecorateTimer = setTimeout(function () {
          assistantDecorateTimer = null
          lastAssistantDecorate = performance.now()
          decorateAssistantAnnotations()
        }, 500 - (now - lastAssistantDecorate))
      }

      function decorateAssistantAnnotations() {
        var rows = assistantRows()
        for (var i = 0; i < rows.length; i++) {
          var el = rows[i]
          if (!isAssistantRow(el) && !isFocusAssistantRow(el)) continue
          // 新版 data-streaming 标记在 AssistantMarkdown 内部元素上（行元素
          // 本身没有）——必须查行内，否则流式输出途中就把「Annotation N：」
          // 替换成芯片，与 React 正在更新的文本节点冲突，整条回复可能渲染
          // 异常（表现为看不到回复消息）。
          if (el.hasAttribute('data-streaming') || el.querySelector('[data-streaming]') !== null) continue
          if (el.querySelector('[data-annotation-reply-chip]') !== null) continue
          if ((el.textContent || '').indexOf('Annotation') === -1) continue
          var items = findPrevAnnotationItems(el)
          // 拿不到条目数据就干脆不生成芯片，保留原文「Annotation N：」——
          // 一个 hover 只显示「未找到对应批注条目」的占位芯片没有任何价值。
          if (items === null || items.length === 0) continue
          decorateAnnotationLabels(el, items)
        }
      }

      /** 在行内所有文本节点中找「Annotation N：」（不区分大小写），替换为芯片。 */
      function decorateAnnotationLabels(row, items) {
        var re = /Annotation[\s\u200b\u200c\u200d\u00ad]*(\d+)[\s\u200b\u200c\u200d\u00ad]*[:：]?/gi
        // 先快照所有文本节点，再逐个处理：遍历中途修改树会让 TreeWalker
        // 指针失效（处理完第一个节点后遍历就断了）——这是「只有第一个
        // Annotation 变成芯片」的根因。
        var nodes = []
        var walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        var n
        while ((n = walker.nextNode()) !== null) nodes.push(n)
        var done = 0
        for (var i = 0; i < nodes.length; i++) {
          n = nodes[i]
          if (n.parentNode === null) continue
          var v = n.nodeValue || ''
          re.lastIndex = 0
          if (!re.test(v)) continue
          var frag = document.createDocumentFragment()
          var last = 0
          re.lastIndex = 0
          var m
          var replaced = 0
          while ((m = re.exec(v)) !== null) {
            if (m.index > last) frag.appendChild(document.createTextNode(v.slice(last, m.index)))
            var num = parseInt(m[1], 10)
            var item = items[num - 1]
            // 编号越界（比如模型自己在思考里写了「Annotation 5：」，实际只有 3 条）
            // 不是真正的逐条回应：原文照旧，不生成芯片。
            if (item !== undefined) {
              frag.appendChild(makeReplyChip(num, item))
              replaced++
              done++
            } else {
              frag.appendChild(document.createTextNode(m[0]))
            }
            last = m.index + m[0].length
          }
          // 一个都没真正替换时绝不碰 DOM：否则 replaceChild 会用一个内容相同的
          // 新节点换上，产生 childList mutation → MutationObserver → 全量装饰 →
          // 再替换…… 自激成死循环，把客户端主线程打满。
          if (replaced === 0) continue
          if (last < v.length) frag.appendChild(document.createTextNode(v.slice(last)))
          n.parentNode.replaceChild(frag, n)
        }
        // 匹配不到完整「Annotation N：」时静默：正文里出现 annotation 这个词
        // （模型自己的措辞、英文注解说明等）本来就不该产生任何日志。
        if (done > 0) {
          console.log('[annotation] 回复批注芯片 ×' + done, row.querySelectorAll('[data-annotation-reply-chip]').length + ' 个元素')
        }
      }

      /** 构造「Annotation N」芯片（hover 显示该批注的原文与批注内容）。
       *  `item` 必定存在：调用方只在编号能对应到批注条目时才生成芯片。 */
      function makeReplyChip(num, item) {
        var chip = document.createElement('span')
        chip.setAttribute('data-annotation-reply-chip', '')
        chip.style.cssText = 'display:inline-flex;align-items:center;height:20px;padding:0 6px;margin:0 2px;border-radius:10px;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #2c2c2e));color:var(--dsw-alias-text-accent,#4c9aff);font-family:var(--dsw-font-family,system-ui);font-size:12px;font-weight:600;cursor:default;vertical-align:middle;'
        chip.textContent = 'Annotation ' + num
        var grace = null
        function hide() {
          if (grace !== null) clearTimeout(grace)
          grace = setTimeout(function () {
            grace = null
            if (shouldKeepTipOpen(chip)) return
            releaseActiveTip()
            clearTip(chip)
          }, 250)
        }
        function keep() {
          if (grace !== null) { clearTimeout(grace); grace = null }
        }
        chip.addEventListener('mouseenter', function () {
          tipActiveHide = { keep: keep, hide: hide }
          var el = document.createElement('div')
          el.className = 'dsh-ann-tip'
          el.style.cssText = 'position:fixed;z-index:1160;width:320px;max-width:calc(100vw - 16px);padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #2c2c2e));box-shadow:var(--dsw-shadow-lv3);font-family:var(--dsw-font-family,system-ui);font-size:12px;color:var(--dsw-alias-label-primary);'
          var head = document.createElement('div')
          head.style.cssText = 'font-weight:600;margin-bottom:6px;'
          head.textContent = t('reply.headWithQuote', { n: num })
          el.appendChild(head)
          var quote = document.createElement('div')
          quote.style.cssText = 'font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-word;padding:6px 8px;border-radius:8px;background:rgba(127,127,127,.12);'
          quote.textContent = truncate(item.text, 140)
          el.appendChild(quote)
          if (typeof item.note === 'string' && item.note !== '') {
            var note = document.createElement('div')
            note.style.cssText = 'font-size:12px;color:var(--dsw-alias-text-accent,#4c9aff);margin-top:6px;word-break:break-word;'
            note.textContent = t('reply.notePrefix') + truncate(item.note, 80)
            el.appendChild(note)
          }
          presentTip(chip, el)
          var r2 = chip.getBoundingClientRect()
          var w2 = 320
          var h2 = el.offsetHeight || 100
          var left = Math.max(8, Math.min(r2.left, window.innerWidth - w2 - 8))
          var top = r2.bottom + 6
          if (top + h2 > window.innerHeight - 8) top = r2.top - h2 - 6
          el.style.left = left + 'px'
          el.style.top = Math.max(8, top) + 'px'
          el.style.width = w2 + 'px'
        })
        chip.addEventListener('mouseleave', hide)
        return chip
      }

      /** 全局轮询装饰：找所有「携带批注块但未装饰」的用户气泡 → 隐藏批注块 + 贴标签。
       *  不依赖发送事件链：异步渲染、刷新后的历史消息都能被覆盖。 */
      function decorateAll() {
        try {
          var rows = allMessageRows()
          for (var i = rows.length - 1; i >= 0; i--) {
            var el = rows[i]
            if (el.hasAttribute('data-pending-steering')) continue
            if (el.querySelector('[data-annotation-bubble-tag]') !== null) continue
            var b = el.querySelector('[class*="bubble"]')
            if (b === null || !hasAnnotationBlock(b.textContent || '')) continue
            // 最新一条优先消费发送时暂存的数据；其余从气泡文本反解析（须在隐藏前）。
            var items = null
            var fromSend = false
            if (i === rows.length - 1 && pendingDeco.length > 0) { items = pendingDeco[0].items; fromSend = true }
            if (items === null || items.length === 0) { items = parseItemsFromBubble(el); fromSend = false }
            if (!hideAnnotationBlock(el)) continue // 内容未渲染完 → 留给下轮（发送暂存数据不弹出）
            if (fromSend) pendingDeco.shift()
            attachBubbleTag(el, items)
            // 2026-10-16 ③：同一批条目也登记给正文标记系统 —— 重启/重开对话后靠这里
            // 把色块和编号重新画出来（以前这份只喂给悬停面板，所以一重启就没了）。
            try { registerRestoredItems(items, el) } catch (_) { /* 恢复失败不影响正常功能 */ }
            // 这里绝不清空待发送批注：DOM 层面无法区分「刚发送的消息」与「会话
            // 切换/刷新后重新渲染的历史消息」，历史消息重装饰曾被误判为已发送而
            // 清空刚恢复的待发送批注（issue #28 复测）。发送清空的唯一权威是
            // watchInputDraft 的「草稿有→空」迁移，其初始化时序洞由订阅重试补齐。
          }
          // 助手回复：把「Annotation N：」变为可悬浮的批注芯片（内容取自最近一条带批注的用户消息）。
          decorateAssistantAnnotations()
        } catch (err) {
          console.warn('[annotation] 装饰扫描失败：', err)
        }
      }

      var decoTimer = null
      /** 全量装饰的合并调度：首个批次立即执行（气泡隐藏要赶在浏览器绘制前，
       *  否则会闪一下批注块），紧随其后的批次合并进 120ms 窗口。
       *  原因：装饰本身会改宿主 DOM（贴标签、换芯片、切气泡文本）并再次触发
       *  MutationObserver，一条回复上的多次替换会在长会话里滚成高频全量扫描，
       *  把主线程烧满——表现就是客户端卡死、什么都点不动。 */
      var decorateAllPending = null
      var lastDecorateAllAt = 0
      function scheduleDecorateAll() {
        var now = performance.now()
        if (now - lastDecorateAllAt >= 120) {
          lastDecorateAllAt = now
          decorateAll()
          return
        }
        if (decorateAllPending !== null) return
        decorateAllPending = setTimeout(function () {
          decorateAllPending = null
          lastDecorateAllAt = performance.now()
          decorateAll()
        }, 120)
      }
      function kickDecorate() {
        decorateAll()
        if (decoTimer === null) decoTimer = setInterval(decorateAll, 1000)
      }

      // ---------- locale 服务（zh/en）订阅与实时回流 ----------
      // locale.subscribe() 触发时：重绘打开中的浮层、更新输入框旁计数与历史气泡标签。
      // 服务缺失（旧 host / 测试环境）时保持 zh，全部功能不变。
      var localeUnsub = null
      function applyLocale() {
        var next = 'zh'
        try {
          if (ctx.locale !== undefined && ctx.locale !== null
            && typeof ctx.locale.getSnapshot === 'function') {
            var snap = ctx.locale.getSnapshot()
            if (snap !== undefined && snap !== null && snap.active) next = String(snap.active)
          }
        } catch (_) { /* keep zh */ }
        if (next === currentLang) return
        setLang(next)
        if (ui.mode !== 'closed') render()
        updateChip()
        // 打开的悬浮面板按新语言关闭（下次 hover 以新语言重建）。
        clearTip()
        var tags = document.querySelectorAll('[data-annotation-bubble-tag]')
        for (var i = 0; i < tags.length; i++) {
          var items = tags[i].__annotationItems
          if (Array.isArray(items)) tags[i].textContent = t('bubble.tag', { n: items.length })
        }
      }
      applyLocale()
      if (ctx.locale !== undefined && ctx.locale !== null
        && typeof ctx.locale.subscribe === 'function') {
        try { localeUnsub = ctx.locale.subscribe(applyLocale) } catch (_) { localeUnsub = null }
      }

      // ---------- 待发送批注按会话恢复 ----------
      // 0.1.6-alpha.2 起选择态已移出 list store：list.subscribe 不再于会话切换时触发。
      // 切换检测三层并行（onSessionSwitch 幂等，重复触发无害）：
      // ① uiSession 的 current source（0.1.7+ 精确；uiSession 晚于插件注册时，
      //    onSessionSwitch 内的惰性探测仍能读到，订阅缺口由轮询兜底）；
      // ② list.subscribe（0.1.6-alpha.2 之前的宿主精确）；
      // ③ 1s 轮询（新宿主上 ② 永不触发、① 缺席时它是唯一触发点）。
      var lastSessionId = readCurrentSessionId()
      ui.quotes = readPendingQuotes(lastSessionId)
      // 2026-10-16 ⑥ 用户复现：**切到别的对话再切回来，正文里的色块+编号就不见了**。
      //   根因：切会话这一刻新会话的消息 DOM 还没渲染完，紧接着那句 renderMarkers() 拿到的是空清单；
      //   之后 decorateAll 见到「已贴标签」的历史行会直接跳过（4051 行），于是**再没有任何东西**
      //   触发一次重画 —— 标记就一直空着。这里补两次延时重画（只多算两次签名，不开新轮询）：
      //   延迟窗口内 DOM 已渲染，markerListFor() 能从上一次贴好的气泡标签里把条目取回来。
      function scheduleMarkerRedraw(ms) {
        try {
          if (typeof setTimeout !== 'function') return
          setTimeout(function () {
            try { decorateAll() } catch (_) { /* 装饰失败不影响重画 */ }
            try { markersSig = null; renderMarkers() } catch (_) { /* ignore */ }
          }, ms)
        } catch (_) { /* ignore */ }
      }
      function onSessionSwitch() {
        var cur = readCurrentSessionId()
        if (cur === lastSessionId) return
        writePendingQuotes(lastSessionId)
        lastSessionId = cur
        if (ui.mode !== 'closed') closeToolbar()
        ui.quotes = readPendingQuotes(cur)
        // 2026-10-16 ③：恢复清单按会话隔离 —— 切会话必须丢掉，否则编号会串会话；
        // 新会话的 DOM 装饰完成后会由 decorateAll 重新登记。
        try { restoredItems = [] } catch (_) { /* ignore */ }
        annotationAttached = false
        // 旧会话未消费的发送暂存作废：留着会被新会话的历史消息误消费（错贴标签）；
        // 旧会话那条消息回切后会由气泡反解析路径重新装饰。
        pendingDeco.length = 0
        ui.noteDraft = ''
        clearTip()
        updateChip()
        watchInputDraft()
        renderMarkers()
        scheduleMarkerRedraw(400)    // DOM 渲染完成后重画一次（覆盖"切回来标记不见了"）
        scheduleMarkerRedraw(1500)   // 再兜一次（慢渲染 / 长会话）
      }
      var unsubList = null
      var unsubSession = null
      var switchTimer = null
      try {
        if (sessions.list !== undefined && sessions.list !== null
          && typeof sessions.list.subscribe === 'function') {
          unsubList = sessions.list.subscribe(onSessionSwitch)
        }
      } catch (_) { unsubList = null }
      try {
        var uiSource = currentSessionSource()
        if (uiSource !== null) unsubSession = uiSource.subscribe(onSessionSwitch)
      } catch (_) { unsubSession = null }
      switchTimer = setInterval(onSessionSwitch, 1000)
      function unsubSessionSwitch() {
        try { if (typeof unsubList === 'function') unsubList() } catch (_) { /* ignore */ }
        try { if (typeof unsubSession === 'function') unsubSession() } catch (_) { /* ignore */ }
        if (switchTimer !== null) { clearInterval(switchTimer); switchTimer = null }
      }
      var unsub = unsubSessionSwitch

      watchInputDraft()
      kickDecorate()
      updateChip()

      // ---------- 清理 ----------
      return function () {
        try { colorStudio() } catch (_) { /* ignore */ }
        clearSettle()
        document.removeEventListener('selectionchange', onSelection)
        document.removeEventListener('pointerdown', onDocPointerDown, true)
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('pointermove', onTipPointerMove, true)
        document.removeEventListener('pointerdown', onSendPointerDown, true)
        document.removeEventListener('click', onSendKeyboardClick, true)
        document.removeEventListener('compositionstart', markImeComposing, true)
        document.removeEventListener('compositionend', markImeEnded, true)
        document.removeEventListener('pointermove', onTipPointerMove, true)
        if (imeClearTimer !== null) { clearTimeout(imeClearTimer); imeClearTimer = null }
        window.removeEventListener('scroll', onLayoutChange, true)
        window.removeEventListener('resize', onLayoutChange)
        host.removeEventListener('pointerdown', onHostPointerDown)
        observer.disconnect()
        if (typeof unsub === 'function') unsub()
        if (inputWatchTimer !== null) { clearInterval(inputWatchTimer); inputWatchTimer = null }
        if (typeof inputUnsub === 'function') inputUnsub()
        if (typeof localeUnsub === 'function') localeUnsub()
        if (decoTimer !== null) { clearInterval(decoTimer); decoTimer = null }
        if (decorateAllPending !== null) { clearTimeout(decorateAllPending); decorateAllPending = null }
        if (composerObserver !== null) composerObserver.disconnect()
        chipLayer.remove()
        tipLayer.remove()
        host.remove()
        overlay.remove()
        numLayer.remove()
      }
    }

    exports.name = 'dsh-xwide-annotation'
    exports.inject = ['sessions', 'conversation', 'locale', 'uiSession']
    exports.apply = apply

    return module.exports
  },
})

// ============================================================================
// [2026-10-16 追加 · 纯新增，上面一行未改] __dshapSelfTest() —— 批注插件活体自测
//
// 用法：页面控制台执行  __dshapSelfTest()            → 返回报告对象
//                        __dshapSelfTest('print')    → 同时打表/打印问题清单
//
// 只读：仅读 DOM 与 getComputedStyle，不写状态、不改样式、不发请求 —— 随时可跑。
// 为什么必须有「活体」这一把（尺子 07 记的已知局限）：离线判定器
// （_annot_extract/ui_contrast.cjs）只能算样式表里写死的颜色，算不出「父元素临时
// 改过背景 / 主题变量被覆盖之后」的真实底色 —— 而「白底白字」那类事故正藏在那里。
//
// 五组检查：0 挂载 · 1 状态 · 2 样式越界（会不会刷到宿主）· 3 对比度（≥4.5:1）· 4 命中区（≥32px）
// ============================================================================
;(function () {
  'use strict'
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (typeof window.__dshapSelfTest === 'function') return   // 已装过就不重复装

  var NS = '[data-annotation-for-dsh]'
  var STYLE_ID = 'annotation-for-dsh-style'
  var MIN_RATIO = 4.5     // 尺子 07：正文对比度 ≥4.5:1
  var MIN_HIT = 32        // 尺子 02：命中区 ≥32px
  var MIN_SWATCH = 28     // 尺子 02：色块 ≥28px
  var CAP = 25            // 每类问题最多列 25 条

  function all(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) } catch (e) { return [] }
  }
  function one(sel, root) {
    try { return (root || document).querySelector(sel) } catch (e) { return null }
  }
  function cs(el) { try { return window.getComputedStyle(el) } catch (e) { return null } }
  function visible(el) {
    var s = cs(el); if (!s) return false
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false
    var r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  function parseColor(v) {
    if (!v) return null
    var m = /^rgba?\(([^)]+)\)$/i.exec(String(v).trim()); if (!m) return null
    var p = m[1].split(/[,\/\s]+/).filter(function (x) { return x !== '' })
    if (p.length < 3) return null
    var r = parseFloat(p[0]), g = parseFloat(p[1]), b = parseFloat(p[2])
    var a = p.length > 3 ? parseFloat(p[3]) : 1
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null
    return [r, g, b, isNaN(a) ? 1 : a]
  }
  function effectiveBg(el) {          // 活体向上找「第一个不透明底色」，全透明就落到 body
    var node = el
    while (node && node.nodeType === 1) {
      var bg = parseColor((cs(node) || {}).backgroundColor)
      if (bg && bg[3] > 0.02) return bg
      node = node.parentElement
    }
    var bb = parseColor((cs(document.body) || {}).backgroundColor)
    return (bb && bb[3] > 0.02) ? bb : [255, 255, 255, 1]
  }
  function lum(rgb) {
    var c = [rgb[0], rgb[1], rgb[2]].map(function (v) {
      v = v / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  function contrast(fg, bg) {
    var a = lum(fg), b = lum(bg), hi = Math.max(a, b), lo = Math.min(a, b)
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
  }
  function tag(el) {
    var c = el.className
    var name = (typeof c === 'string' && c.trim()) ? '.' + c.trim().split(/\s+/).slice(0, 3).join('.') : el.tagName.toLowerCase()
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16)
    return name + (t ? '「' + t + '」' : '')
  }
  function ownText(el) {              // 只看元素自己的文字节点（不含子元素）
    var s = ''
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue
    }
    return s.replace(/\s+/g, ' ').trim()
  }
  function styleRules() {             // 含 @media 内层，全部拍平
    var st = document.getElementById(STYLE_ID)
    if (!st) return { error: '找不到 #' + STYLE_ID }
    var top
    try { top = st.sheet && st.sheet.cssRules } catch (e) { return { error: 'cssRules 不可读：' + e.message } }
    if (!top) return { error: '#STYLE_ID 的 sheet 为空' }
    var out = []
    ;(function walk(rules) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i]
        if (r.selectorText) out.push(r)
        if (r.cssRules && r.cssRules.length && r.selectorText === undefined) walk(r.cssRules)
      }
    })(top)
    return { rules: out }
  }

  function checkMount() {
    var got = styleRules()
    return {
      style_el: !!document.getElementById(STYLE_ID),
      style_rules: got.rules ? got.rules.length : -1,
      style_error: got.error || null,
      host: !!one(NS),
      overlay: all('[data-annotation-overlay]').length,
      num_layer: all('[data-annotation-num-layer]').length,
      chip_layer: all('[data-annotation-chip]').length,
      tip_layer: all('[data-annotation-tip-layer]').length,
      probe_hint: '控制台过滤 ANNOT-PROBE 可看 apply() 是否跑过'
    }
  }

  function checkState() {
    var items = 0
    var tags = all('[data-annotation-bubble-tag]')
    tags.forEach(function (t) {
      var arr = t.__annotationItems
      if (arr && typeof arr.length === 'number') items += arr.length
    })
    var idx = {}
    all('[data-ann-index]').forEach(function (el) { idx[el.getAttribute('data-ann-index')] = 1 })
    return {
      highlights: all('.dsh-ann-hl').length,
      number_chips: all('.dsh-ann-num').length,
      distinct_index: Object.keys(idx).length,
      bubble_tags: tags.length,
      items_in_tags: items,
      reply_chips: all('[data-annotation-reply-chip]').length,
      open_card: all('.dsh-ann-card').length,
      toast: all('[data-annotation-toast]').length,
      draft_input: all('.dsh-ann-input').length
    }
  }

  // 一条选择器算不算「待在插件自己的命名空间里」：
  //   ① 以 [data-annotation-for-dsh] 开头（插件宿主容器）→ 合规
  //   ② 最左边那个简单选择器是插件自己的类（.dsh-ann-…）/ data-annotation-* 属性 → 只有插件元素会命中它，合规
  //   ③ 其余（`*` / `button` / `div` / `.foo` / `#bar` …）→ 能刷到宿主元素，算越界（历史事故类型）
  function isNamespaced(sel) {
    var s = String(sel || '').trim()
    if (!s) return true
    if (s.indexOf('[data-annotation-for-dsh]') === 0) return true
    if (s.charAt(0) === '.') return /^\.dsh-ann-[A-Za-z0-9_-]+/.test(s)
    if (s.charAt(0) === '[') return /^\[data-annotation-/.test(s)
    if (s.charAt(0) === '#') return /^#(annotation-for-dsh|dsh-ann-)/.test(s)
    return false
  }

  function checkStyleLeak() {
    var got = styleRules()
    if (!got.rules) return { rules_total: 0, important_color_decls: 0, unnamespaced_selectors: [], error: got.error }
    var rules = got.rules, unnamespaced = [], important = 0
    rules.forEach(function (r) {
      var txt = r.cssText || ''
      if (/!\s*important/i.test(txt) && /(^|[\s;{])(color|background|background-color)\s*:/i.test(txt)) important++
      var sel = r.selectorText
      if (!sel) return
      sel.split(',').forEach(function (part) {
        var s = part.trim()
        if (!s) return
        if (isNamespaced(s)) return                                    // 在插件命名空间里 → 合规
        if (unnamespaced.length < CAP) unnamespaced.push(s)
      })
    })
    return {
      rules_total: rules.length,
      important_color_decls: important,
      unnamespaced_selectors: unnamespaced,
      note: 'unnamespaced_selectors 非空 = 这些规则既没有 [data-annotation-for-dsh] 前缀、最左边也不是 .dsh-ann-*，可能刷到宿主元素（历史事故类型）'
    }
  }

  function checkContrast() {
    var bad = [], checked = 0
    all(NS + ' *').forEach(function (el) {
      if (!ownText(el)) return
      var s = cs(el); if (!s || !visible(el)) return
      var fg = parseColor(s.color); if (!fg || fg[3] < 0.02) return
      checked++
      var bg = effectiveBg(el)
      var cr = contrast(fg, bg)
      if (cr < MIN_RATIO && bad.length < CAP) {
        bad.push({ el: tag(el), ratio: cr, fg: s.color, bg: 'rgb(' + bg.slice(0, 3).join(',') + ')', need: MIN_RATIO })
      }
    })
    return { checked_text_nodes: checked, violations: bad }
  }

  function checkHitArea() {
    var small = []
    all(NS + ' button, ' + NS + ' [role="button"], ' + NS + ' [data-swatch], ' + NS + ' .dsh-ann-action, ' + NS + ' .dsh-ann-qdel').forEach(function (el) {
      if (!visible(el)) return
      var r = el.getBoundingClientRect()
      var min = el.hasAttribute('data-swatch') ? MIN_SWATCH : MIN_HIT
      if (r.width < min || r.height < min) {
        if (small.length < CAP) small.push({ el: tag(el), size: Math.round(r.width) + '×' + Math.round(r.height), need: min })
      }
    })
    return { violations: small }
  }

  // 2026-10-17 追加 · 第 6 组检查：批注数据落在 localStorage 的三把键（颜色 / 隐藏 / 角标位置）。
  // 只读。为什么必须查：颜色和隐藏都是**永久固化**的（键 dshap.itemColors / dshap.hidden），
  // 用户报的「取消自定义颜色后没回到有用颜色」「过一会儿标记自己不见了」都住在这两把键里。
  function checkStorage() {
    function keys(k) {
      try { var o = JSON.parse(localStorage.getItem(k) || '{}'); return (o && typeof o === 'object') ? o : null } catch (e) { return null }
    }
    var colors = keys('dshap.itemColors'), hidden = keys('dshap.hidden')
    var dark = [], parse_errors = []
    if (!colors || typeof colors !== 'object') parse_errors.push('dshap.itemColors 不是合法 JSON')
    if (!hidden || typeof hidden !== 'object') parse_errors.push('dshap.hidden 不是合法 JSON')
    if (colors && typeof colors === 'object') {
      Object.keys(colors).forEach(function (k) {
        var hex = String(colors[k] || '')
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return
        var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
        var L = 0.2126 * Math.pow((r / 255 + 0.055) / 1.055, 2.4) +
                0.7152 * Math.pow((g / 255 + 0.055) / 1.055, 2.4) +
                0.0722 * Math.pow((b / 255 + 0.055) / 1.055, 2.4)
        if (L < 0.45 && dark.length < CAP) dark.push(hex + ' ← ' + String(k).slice(0, 24))
      })
    }
    var nHidden = (hidden && typeof hidden === 'object') ? Object.keys(hidden).filter(function (k) { return hidden[k] === 1 || hidden[k] === '1' }).length : -1
    return {
      item_colors: colors ? Object.keys(colors).length : -1,
      hidden_active: nHidden,
      dark_colors: dark,
      parse_errors: parse_errors,
      note: 'dark_colors 非空 = 这些固化色亮度 <0.45（插件已用 hlVisibleColor 提亮后才画，这里只报历史值）；hidden_active = 当前按文字隐藏的条数'
    }
  }

  function run(print) {
    var checks = {
      mount: checkMount(),
      state: checkState(),
      style_leak: checkStyleLeak(),
      contrast: checkContrast(),
      hit_area: checkHitArea(),
      storage: checkStorage()
    }
    var problems = []
    if (!checks.mount.style_el) problems.push('样式表 #' + STYLE_ID + ' 不在（插件没起或已被卸载）')
    if (!checks.mount.host) problems.push('宿主容器 ' + NS + ' 不在（插件没挂上）')
    if (checks.style_leak.unnamespaced_selectors && checks.style_leak.unnamespaced_selectors.length) {
      problems.push('样式越界 ' + checks.style_leak.unnamespaced_selectors.length + ' 条：' +
        checks.style_leak.unnamespaced_selectors.slice(0, 3).join(' | '))
    }
    if (checks.contrast.violations.length) {
      problems.push('对比度不足 ' + checks.contrast.violations.length + ' 处（最低 ' +
        checks.contrast.violations[0].ratio + ':1）')
    }
    if (checks.hit_area.violations.length) problems.push('命中区偏小 ' + checks.hit_area.violations.length + ' 处')
    if (checks.storage && checks.storage.parse_errors && checks.storage.parse_errors.length) {
      problems.push('批注数据键损坏：' + checks.storage.parse_errors.join('；'))
    }
    var report = {
      ok: problems.length === 0,
      at: new Date().toISOString(),
      url: (typeof location !== 'undefined' ? location.href : ''),
      thresholds: { contrast: MIN_RATIO, hit: MIN_HIT, swatch: MIN_SWATCH },
      problems: problems,
      checks: checks
    }
    if (print) {
      try {
        console.log('%c[__dshapSelfTest] ' + (report.ok ? 'OK' : 'FAIL ' + problems.length + ' 个问题'),
          report.ok ? 'color:#22c55e' : 'color:#ef4444')
        if (problems.length) console.log(problems.join('\n'))
        if (checks.contrast.violations.length) console.table(checks.contrast.violations)
        if (checks.hit_area.violations.length) console.table(checks.hit_area.violations)
        console.log(report)
      } catch (e) { /* 控制台不可用时静默 */ }
    }
    return report
  }

  var api = function (arg) { return run(arg === true || arg === 'print' || arg === 'table') }
  api.version = '1.0'
  api.help = '用法：__dshapSelfTest() 返回报告对象；__dshapSelfTest("print") 附带打表。只读、无副作用。'
  try { window.__dshapSelfTest = api } catch (e) { /* ignore */ }
})()

// ============================================================================
// [2026-10-16 追加 · 纯新增] 自检角标：不用开发者工具也能看到自检结果
//
// 屏幕左下角一个小胶囊：
//     绿色「● 批注自检 OK」 / 红色「● 批注自检 N 个问题」
//     单击 = 重新自检 + 展开/收起明细        双击 = 本次隐藏（刷新后回来）
// 只读体检；角标挂在 body 上（不进批注插件的宿主容器），不碰插件任何状态与样式。
// 批注区 DOM 有变化时（开启高亮、写批注、发消息）自动重跑一次，节流 900ms。
// ============================================================================
;(function () {
  'use strict'
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.__dshapSelftestBadge) return
  window.__dshapSelftestBadge = '1.2'

  var ID = 'dshap-selftest-badge'
  var POS_KEY = 'dshap-badge-pos'
  var VIS_KEY = 'dshap-badge-visible'   // 插件页那行「配置」里的开关写的键：'0' = 隐藏角标
  var box = null, pill = null, panel = null, dot = null, label = null, chev = null, dotMark = null, expanded = false, collapsed = false, pending = null, pendingFade = null, tries = 0, started = false
  // 2026-10-17 修：双击胶囊 = 本次隐藏（只藏这一趟，不写 localStorage，刷新就回来）
  var hideThisSession = false

  function imp(el, prop, val) { try { el.style.setProperty(prop, val, 'important') } catch (e) { /* ignore */ } }
  function find(id) { try { return document.getElementById(id) } catch (e) { return null } }
  function v(x) { return (x === undefined || x === null) ? '–' : x }

  // 插件页那一行的「配置」里有个开关，写的就是 VIS_KEY（'0' = 关）。
  // 开关不用刷新页面 —— 开关插件会派发 dshap-badge-visible-change 事件，这里立刻响应。
  function hiddenBySwitch() {
    if (hideThisSession) return true   // 2026-10-17 修：双击隐藏的会话内状态
    try { return !!(window.localStorage && window.localStorage.getItem(VIS_KEY) === '0') } catch (e) { return false }
  }

  function applyVisible() {
    if (hiddenBySwitch()) {
      if (box) imp(box, 'display', 'none')
      if (dot) imp(dot, 'display', 'none')
      try { if (typeof console !== 'undefined') console.log('[dshap-badge] 已按插件页开关隐藏（打开开关后立即回来）') } catch (e) {}
      return
    }
    build()
    if (!box) return
    // 安静模式（2026-10-16 用户选 B）：自检**没有问题**时完全不露面 —— 平时不占地方、不挡你操作；
    //   一旦查出问题（样式越界 / 对比度 / 命中区 / 挂载）立刻自己冒出来。正在展开细看时保持可见。
    var last = null
    try { last = window.__dshapLastReport || null } catch (eQ) { last = null }
    var quiet = !!(last && last.ok === true && !expanded)
    if (quiet) { imp(box, 'display', 'none'); if (dot) imp(dot, 'display', 'none') }
    else if (collapsed) { imp(box, 'display', 'none'); if (dot) imp(dot, 'display', 'block') }
    else { imp(box, 'display', 'flex'); if (dot) imp(dot, 'display', 'none') }
    if (!started) { started = true; run(); watch() }
  }

  function build() {
    if (box) return box
    if (find(ID)) { box = find(ID); pill = find(ID + '-pill'); panel = find(ID + '-panel'); dot = find(ID + '-dot'); if (dot) return box }
    if (!document.body && !document.documentElement) return null
    box = document.createElement('div'); box.id = ID
    var saved = null
    try { saved = JSON.parse((window.localStorage && window.localStorage.getItem(POS_KEY)) || 'null') } catch (e) { saved = null }
    imp(box, 'position', 'fixed')
    if (saved && typeof saved.right === 'number' && typeof saved.top === 'number') {
      imp(box, 'right', saved.right + 'px'); imp(box, 'top', saved.top + 'px')    // 拖过的位置（贴右 + 贴顶）
    } else if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
      imp(box, 'left', saved.left + 'px'); imp(box, 'top', saved.top + 'px')      // 旧格式兼容
    } else {
      imp(box, 'right', '16px'); imp(box, 'bottom', '16px')   // 默认右下角：左下角会压住侧栏底部的按钮
    }
    try { if (saved && saved.collapsed) collapsed = true } catch (e0) { /* ignore */ }
    imp(box, 'z-index', '2147483000'); imp(box, 'display', 'flex'); imp(box, 'flex-direction', 'column')
    imp(box, 'pointer-events', 'auto')   // 防呆：绝不允许自己被任何继承的 none 吃掉点击
    imp(box, 'align-items', 'flex-end'); imp(box, 'gap', '6px')
    imp(box, 'font', '12px/1.45 system-ui, "Microsoft YaHei", sans-serif')
    imp(box, 'transition', 'opacity .25s')

    pill = document.createElement('div'); pill.id = ID + '-pill'
    imp(pill, 'padding', '4px 10px'); imp(pill, 'border-radius', '999px'); imp(pill, 'cursor', 'pointer')
    imp(pill, 'pointer-events', 'auto')   // 2026-10-17 修：胶囊自己也要显式可点，不吃继承的 none
    imp(pill, 'border', '1px solid #666'); imp(pill, 'background', 'rgba(24,24,26,.94)'); imp(pill, 'color', '#e5e5e5')
    imp(pill, 'box-shadow', '0 2px 10px rgba(0,0,0,.4)'); imp(pill, 'user-select', 'none'); imp(pill, 'white-space', 'nowrap')
    // 文字放进一个子 span：直接改 pill.textContent 会把 × 那个子元素一起抹掉（踩过一次）
    label = document.createElement('span'); label.textContent = '● 自检 …'; pill.appendChild(label)
    // 2026-10-16 ⑤ 用户批注：「加个小箭头/详情字样，让人一眼知道能点开」——只加一个箭头，不改原有布局
    chev = document.createElement('span'); chev.textContent = '▾'
    imp(chev, 'margin-left', '6px'); imp(chev, 'opacity', '.75')
    try { chev.title = '展开/收起明细' } catch (eC1) {}
    pill.appendChild(chev)
    try { pill.title = '单击=看明细（箭头 ▾ 会变成 ▴）；× 收起成小圆点；按住可拖到任意角落' } catch (e) {}
    // 2026-10-16 B：只有「刚拖完那一下」的 click 被丢掉（300ms 窗口），不再用常驻的 moved 标志 ——
    //   旧写法把 moved 留着不清，拖过一次之后**第一次点击会被永久吞掉**，看起来就是「点不动」。
    pill.addEventListener('click', function () {
      if (typeof suppressClickUntil === 'number' && suppressClickUntil && Date.now() < suppressClickUntil) return
      expanded = !expanded; run(); applyVisible()
    })

    // 一个**永远看得见**的开关：胶囊右边的 × = 收起成一个小圆点；点圆点 = 展开回来。
    // 没有"藏起来就找不回来"的状态 —— 不靠刷新、不靠快捷键、不靠右键菜单，开关始终在屏幕上。
    dot = document.createElement('div'); dot.id = ID + '-dot'
    // 2026-10-16 ⑤ 用户批注：「收起成圆点后，圆点上也留个小标记」——
    //   圆点里放一个状态符号（●=OK / !=有问题），同时把命中区做成 32px（尺子/02：命中区 ≥32px）
    imp(dot, 'display', 'none'); imp(dot, 'width', '32px'); imp(dot, 'height', '32px'); imp(dot, 'border-radius', '50%')
    imp(dot, 'pointer-events', 'auto')   // 2026-10-17 修：圆点显式可点
    imp(dot, 'background', 'rgba(24,24,26,.92)'); imp(dot, 'border', '1px solid #666')
    imp(dot, 'box-shadow', '0 2px 8px rgba(0,0,0,.4)'); imp(dot, 'cursor', 'pointer'); imp(dot, 'user-select', 'none')
    imp(dot, 'align-items', 'center'); imp(dot, 'justify-content', 'center')
    dotMark = document.createElement('span'); dotMark.textContent = '●'
    imp(dotMark, 'font-size', '13px'); imp(dotMark, 'line-height', '1'); imp(dotMark, 'color', '#22c55e')
    dot.appendChild(dotMark)
    try { dot.title = '批注自检（点一下展开）' } catch (e12) {}
    dot.addEventListener('click', function () { expanded = true; setCollapsed(false); run() })   // 2026-10-17 修：点圆点=展开并立刻看结果（旧写法在自检 OK 时一点就把角标整个点没了）

    var close = document.createElement('span')
    imp(close, 'margin-left', '8px'); imp(close, 'padding', '0 4px'); imp(close, 'border-radius', '4px'); imp(close, 'opacity', '.8')
    close.textContent = '\u00d7'
    try { close.title = '收起成小圆点（点圆点就展开回来）' } catch (e13) {}
    close.addEventListener('click', function (ev) { try { ev.stopPropagation() } catch (e14) {} setCollapsed(true) })
    pill.appendChild(close)

    function currentPos() {
      var o = {}
      try { var r = box.getBoundingClientRect(); o.right = Math.round(viewW() - r.right); o.top = Math.round(r.top) } catch (e15) { o = {} }
      return o
    }
    function saveState() {
      try { var q = currentPos(); q.collapsed = collapsed; window.localStorage.setItem(POS_KEY, JSON.stringify(q)) } catch (e16) { /* ignore */ }
    }
    function setCollapsed(v) {
      collapsed = !!v
      if (collapsed) {
        imp(box, 'display', 'none')
        var st = ['right', 'left', 'top', 'bottom'], i2, v2
        for (i2 = 0; i2 < 4; i2++) {
          v2 = ''
          try { v2 = box.style.getPropertyValue(st[i2]) } catch (e17) { v2 = '' }
          imp(dot, st[i2], v2 ? v2 : 'auto')
        }
        imp(dot, 'display', 'block')
      } else {
        imp(dot, 'display', 'none')
        imp(box, 'display', 'flex')
      }
      saveState()
      applyVisible()   // 开关关着时，收起/展开都不许把角标露出来
      try { if (typeof console !== 'undefined') console.log('[dshap-badge] ' + (collapsed ? '已收成小圆点（点圆点展开）' : '已展开为胶囊')) } catch (e18) {}
    }
    // 2026-10-17 修：双击 = 本次隐藏（文件头注释承诺的行为；旧写法是「切换展开」，双击等于白点）
    pill.addEventListener('dblclick', function (e) { e.preventDefault(); hideThisSession = true; applyVisible() })

    // 按住胶囊可以拖到任意角落；**必须真的拖动了才改定位** —— 只点一下不许跳位置。
    // 锚点用「贴右 + 贴顶」：面板是右对齐的，贴右锚定后它只会往左长，不会跑出屏幕。
    var dragging = false, moved = false, sx = 0, sy = 0, sRight = 16, sTop = 0
    var suppressClickUntil = 0   // 只有"刚拖完"那一下点击被丢掉；拖完立刻归零，不留后遗症
    function viewW() { return (typeof window.innerWidth === 'number' && window.innerWidth) || 0 }
    function viewH() { return (typeof window.innerHeight === 'number' && window.innerHeight) || 0 }
    function dragStart(e) {
      var r = null
      try { r = box.getBoundingClientRect() } catch (err) { r = null }
      if (!r || typeof r.right !== 'number' || typeof r.top !== 'number') return
      dragging = true; moved = false
      sx = e.clientX || 0; sy = e.clientY || 0
      sRight = viewW() - r.right; sTop = r.top
      // 这里**不动定位**：等真移动超过 3px 再切坐标系（否则 mousedown 一响位置就变 = 点一下跳一下）
    }
    function dragMove(e) {
      if (!dragging) return
      var dx = (e.clientX || 0) - sx, dy = (e.clientY || 0) - sy
      // 2026-10-17 修「点不动」根因：阈值 3px 太苛刻 —— 鼠标/触控板从按下到抬起手就拖不拑 3px，
      //   于是每次普通点击都被当成“拖动”，紧接的 click 被 suppressClickUntil 吞掉 → 看起来就是点不了。
      if (Math.abs(dx) + Math.abs(dy) > 8) moved = true
      if (!moved) return
      var right = Math.max(0, Math.min(Math.max(0, viewW() - 60), sRight - dx))
      var top = Math.max(0, Math.min(Math.max(0, viewH() - 24), sTop + dy))
      imp(box, 'right', Math.round(right) + 'px'); imp(box, 'left', 'auto')
      imp(box, 'top', Math.round(top) + 'px'); imp(box, 'bottom', 'auto')
      imp(box, 'opacity', '1')
    }
    function dragEnd() {
      if (!dragging) return
      dragging = false
      if (!moved) return
      saveState()
      moved = false                        // 立刻归零：不许留下"下一次点击被吞掉"的状态
      suppressClickUntil = Date.now() + 150   // 2026-10-17 修：真拖完才短暂吞一下，300ms 太长容易连正常点击一起吞掉
    }
    pill.addEventListener('mousedown', dragStart)
    pill.addEventListener('touchstart', dragStart)
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('mousemove', dragMove); document.addEventListener('mouseup', dragEnd)
      document.addEventListener('touchmove', dragMove); document.addEventListener('touchend', dragEnd)
    }

    // 闲着 8 秒自动淡到 35%，鼠标移上去恢复 —— 平时不挡视线
    function scheduleFade() { if (typeof setTimeout === 'function') pendingFade = setTimeout(function () { imp(box, 'opacity', '.35') }, 8000) }
    pill.addEventListener('mouseenter', function () { imp(box, 'opacity', '1'); if (typeof clearTimeout === 'function') clearTimeout(pendingFade); scheduleFade() })
    pill.addEventListener('mouseleave', scheduleFade)
    scheduleFade()

    box.appendChild(pill)

    panel = document.createElement('div'); panel.id = ID + '-panel'
    imp(panel, 'display', 'none'); imp(panel, 'max-width', '460px'); imp(panel, 'max-height', '52vh')
    imp(panel, 'overflow', 'auto'); imp(panel, 'padding', '8px 10px'); imp(panel, 'border-radius', '8px')
    imp(panel, 'border', '1px solid #444'); imp(panel, 'background', 'rgba(17,17,19,.97)'); imp(panel, 'color', '#e5e5e5')
    imp(panel, 'white-space', 'pre-wrap'); imp(panel, 'box-shadow', '0 4px 18px rgba(0,0,0,.5)')
    box.appendChild(panel)

    ;(document.body || document.documentElement).appendChild(box)
    try { (document.body || document.documentElement).appendChild(dot) } catch (e19) { /* ignore */ }
    if (collapsed) setCollapsed(true)
    return box
  }

  function detail(r) {
    var c = r.checks || {}, m = c.mount || {}, s = c.state || {}, l = c.style_leak || {}, k = c.contrast || {}, h = c.hit_area || {}
    var pr = r.problems || [], leak = l.unnamespaced_selectors || [], cv = k.violations || [], hv = h.violations || []
    var out = [], i
    out.push('自检时间 ' + v(r.at) + '   ' + v(r.url))
    out.push('阈值：对比度 ≥4.5:1 · 命中区 ≥32px · 色块 ≥28px')
    out.push('')
    out.push('问题（' + pr.length + '）')
    if (pr.length) { for (i = 0; i < pr.length; i++) out.push('  · ' + pr[i]) } else out.push('  · 无')
    out.push('')
    out.push('数字')
    out.push('  挂载：样式表 ' + (m.style_el ? '✓' : '✗') + '（规则 ' + v(m.style_rules) + ' 条）· 宿主 ' + (m.host ? '✓' : '✗') +
      ' · overlay ' + v(m.overlay) + ' / num ' + v(m.num_layer) + ' / chip ' + v(m.chip_layer) + ' / tip ' + v(m.tip_layer))
    if (m.style_error) out.push('  样式表读取：' + m.style_error)
    out.push('  状态：高亮 ' + v(s.highlights) + ' · 编号 ' + v(s.number_chips) + ' · 不同编号 ' + v(s.distinct_index) +
      ' · 批注条 ' + v(s.bubble_tags) + '（条内批注 ' + v(s.items_in_tags) + '）· 回复芯片 ' + v(s.reply_chips))
    out.push('  样式：规则 ' + v(l.rules_total) + ' 条 · !important 颜色 ' + v(l.important_color_decls) + ' 条 · 越界选择器 ' + leak.length + ' 条')
    for (i = 0; i < leak.length; i++) out.push('     越界 → ' + leak[i])
    out.push('  对比度：检查 ' + v(k.checked_text_nodes) + ' 个文本节点 · 违规 ' + cv.length)
    for (i = 0; i < cv.length; i++) out.push('     ' + cv[i].ratio + ':1  ' + cv[i].el + '   字色 ' + cv[i].fg + ' / 底色 ' + cv[i].bg)
    out.push('  命中区：违规 ' + hv.length)
    for (i = 0; i < hv.length; i++) out.push('     ' + hv[i].size + '（需 ≥' + hv[i].need + 'px）  ' + hv[i].el)
    try {
      var tl = JSON.parse(localStorage.getItem('dshap.telemetry') || '[]')
      var lastTl = tl.length ? tl[tl.length - 1] : null
      out.push('  遥测：构建 ' + (window.__dshapBuild || '?') + ' · 采样 ' + tl.length + ' 条' +
        (lastTl ? ' · 最近 高亮 ' + lastTl.hl + ' / 编号 ' + lastTl.num + ' / 清单 ' + lastTl.items + ' / 行 ' + lastTl.rows + '（' + lastTl.why + ' ' + lastTl.at + '）' : ''))
    } catch (eTl) { /* ignore */ }
    return out.join('\n')
  }

  function paint(r) {
    build()
    if (!pill || !panel) return
    if (hiddenBySwitch()) { applyVisible(); return }   // 开关关着：照常自检，但不显示角标
    var n = (r.problems || []).length
    var labelText = r.ok ? '● 自检 OK' : '● 自检 ' + n + ' 问题'
    if (label) label.textContent = labelText; else pill.textContent = labelText
    try { if (chev) chev.textContent = expanded ? '▴' : '▾' } catch (eC2) {}
    try { if (dotMark) { dotMark.textContent = r.ok ? '●' : '!'; imp(dotMark, 'color', r.ok ? '#22c55e' : '#f87171') } } catch (eC3) {}
    try { pill.title = (r.ok ? '自检 OK' : '自检 ' + n + ' 个问题') + '（单击' + (expanded ? '收起明细 ▴' : '看明细 ▾') + ' / × 收起成小圆点 / 按住可拖）' } catch (e) {}
    imp(pill, 'background', r.ok ? 'rgba(20,83,45,.95)' : 'rgba(127,29,29,.95)')
    imp(pill, 'color', r.ok ? '#d1fae5' : '#fee2e2')
    imp(pill, 'border-color', r.ok ? '#22c55e' : '#ef4444')
    panel.textContent = detail(r)
    imp(panel, 'display', expanded ? 'block' : 'none')
    applyVisible()   // 自检一出结果就按安静模式决定露不露面（没问题就不露面）
  }

  function run() {
    if (typeof window.__dshapSelfTest !== 'function') {
      if (tries++ < 60 && typeof setTimeout === 'function') { setTimeout(run, 1000); return }
      paint({ ok: false, at: new Date().toISOString(), url: '', problems: ['__dshapSelfTest 不存在（插件没加载，或页面没刷新）'], checks: {} })
      return
    }
    var r
    try { r = window.__dshapSelfTest() }
    catch (e) { r = { ok: false, at: new Date().toISOString(), url: '', problems: ['自检自身抛异常：' + (e && e.message)], checks: {} } }
    window.__dshapLastReport = r
    paint(r)
    try { if (typeof console !== 'undefined') console.log('[dshap-badge] ' + ((label && label.textContent) ? label.textContent : pill.textContent)) } catch (e) {}
  }

  function watch() {
    if (typeof MutationObserver === 'undefined') return
    var host = null
    try { host = document.querySelector('[data-annotation-for-dsh]') } catch (e) { host = null }
    if (!host) return
    var mo = new MutationObserver(function () {
      if (pending && typeof clearTimeout === 'function') clearTimeout(pending)
      if (typeof setTimeout === 'function') pending = setTimeout(run, 900)
    })
    try { mo.observe(host, { childList: true, subtree: true, attributes: true }) } catch (e) { /* ignore */ }
  }

  function boot() {
    applyVisible()   // 可见性由插件页那行的开关决定；第一次可见时顺手启动自检与 DOM 监听
    try { if (typeof window.addEventListener === 'function') window.addEventListener('dshap-badge-visible-change', applyVisible) } catch (e20) { /* ignore */ }
  }

  if (typeof setTimeout === 'function') setTimeout(boot, 1200)
  else boot()
})()
