# Usage guide · dsh-xwide-annotation

> The full, screenshot-backed guide lives in **[docs/USAGE.zh-CN.md](./USAGE.zh-CN.md)** (简体中文). This is the short English version.

## Quick start

1. **Select any text** in an assistant reply → the floating toolbar shows **「+ 批注」**.
2. Click it → the *Add annotation* card opens → type a note (**may stay empty** = highlight only) → **「✓ 保存批注」**. A colored number badge + highlight appears on the source text.
3. Repeat as needed, then press **Enter** in the input box. The annotation block is sent together with your question, and the model answers each one as `Annotation 1: …`, `Annotation 2: …`.

Your own bubble never shows the annotation text — only your question plus a **「批注 ×N」** chip (hover to review, delete single items). Every `Annotation N` in the reply is a hoverable chip showing the quoted source and your note.

## UI map

| Where | What |
|---|---|
| Selection toolbar | **+ 批注** — create an annotation |
| Bottom-right dot 🎨 | **Color studio** — 4 neon presets (`#ffc300` `#2ecc71` `#00c8ff` `#ff63c5`), custom picker (drag or type hex, then 确定), draggable dot, `Alt+Shift+C` cycles presets |
| Clipboard icon 📋 | **Annotation outline** — list all annotations of this chat, click to jump and highlight; per-item ✏ edit / 🗑 remove; **「Clear all」** asks for confirmation, cannot be undone, and is **scoped to the current session** since v1.5.0 |
| Above the input box | **批注 ×N** chip — pending annotations before sending |
| Page corner pill | **Self-check**: green `● 自检 OK` / red `● 自检 N 问题`; click = re-run + expand details; quiet mode hides it when everything is fine |

## Data & privacy

Everything stays in your browser's `localStorage` (`dshap.color`, `dshap.pos.v2`, `dshap.mode`, `dshap.itemColors`, `dshap.hidden`, `dshap.telemetry`, `dsh.sessions.current`). Nothing is uploaded. Delete those keys to reset.

## Verify the plugin loaded

```js
window.__DSH_BOOT__.entries.find(e => e.id === 'dsh-xwide-annotation')
```

## Uninstall

```sh
dsh plugin --profile web remove dsh-xwide-annotation
```
