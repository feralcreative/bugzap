export const styles = `
:host { all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.surface { all: initial; display: block; position: fixed; inset: 0; margin: 0; padding: 0; border: 0; width: 100%; height: 100%; background: transparent; color: #181818; font: 14px/1.5 system-ui, sans-serif; pointer-events: none; overflow: visible; }
button, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; background: white; border: 1px solid #b8b8b8; border-radius: 5px; padding: 9px 13px; }
button:hover { background: #ededed; }
button:focus-visible, textarea:focus-visible, select:focus-visible { outline: 3px solid #2763c7; outline-offset: 2px; }
button:disabled { opacity: .6; cursor: wait; }
.primary { background: #181818; border-color: #181818; color: white; }
.primary:hover { background: #383838; }
.launcher { position: absolute; right: 20px; bottom: 20px; pointer-events: auto; box-shadow: 0 2px 8px #0002; }
.bar { position: absolute; left: 50%; top: 16px; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; width: max-content; max-width: calc(100% - 32px); padding: 12px; background: white; border: 1px solid #bbb; border-radius: 8px; box-shadow: 0 2px 14px #0002; pointer-events: auto; }
.bar p { margin: 0; }
.backdrop { position: absolute; inset: 0; background: #0003; pointer-events: auto; }
.panel { position: absolute; right: 16px; bottom: 16px; width: min(410px, calc(100% - 32px)); max-height: calc(100% - 32px); overflow-y: auto; padding: 20px; border: 1px solid #bbb; border-radius: 8px; background: white; box-shadow: 0 4px 24px #0003; pointer-events: auto; }
h2 { font-size: 19px; line-height: 1.3; margin: 0 0 14px; }
p { margin: 10px 0; }
label { display: block; margin: 14px 0 5px; font-weight: 600; }
textarea, select { display: block; width: 100%; padding: 9px; border: 1px solid #999; border-radius: 4px; background: white; }
textarea { min-height: 130px; resize: vertical; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.target { font-size: 13px; color: #555; }
.target button { padding: 3px 7px; margin-left: 6px; font-size: 12px; }
.error { color: #9a2020; min-height: 21px; }
.highlight { position: absolute; border: 2px solid #2763c7; background: #2763c711; border-radius: 2px; pointer-events: none; }
.pin { position: absolute; width: 20px; height: 20px; border: 3px solid white; border-radius: 50%; background: #2763c7; box-shadow: 0 0 0 1px #2763c7; transform: translate(-50%, -50%); pointer-events: none; }
.saved-pins { position: absolute; inset: 0; pointer-events: none; }
.saved-pin { position: absolute; width: 28px; height: 28px; padding: 0; border: 2px solid white; border-radius: 50%; background: #2763c7; color: white; transform: translate(-50%, -50%); box-shadow: 0 0 0 1px #2763c7; pointer-events: auto; font-size: 12px; font-weight: 600; }
.saved-pin:hover { background: #174a9e; }
.saved-pin[data-approximate="true"] { background: white; color: #174a9e; border: 2px dashed #2763c7; }
.pins-toggle { position: absolute; right: 130px; bottom: 20px; pointer-events: auto; }
.report-body { white-space: pre-wrap; overflow-wrap: anywhere; }
`
