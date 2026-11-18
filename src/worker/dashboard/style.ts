// The dashboard's whole stylesheet, served at /dashboard.css. A string rather than
// a build step: the Worker has no CSS pipeline, and the page's CSP allows styles
// only from its own origin, so nothing is inlined.
export const dashboardCss = `
:root {
  color-scheme: light dark;
  --bg: #f6f6f4; --panel: #ffffff; --ink: #181818; --muted: #5b5b5b; --line: #cfcfcb;
  --accent: #2763c7; --accent-ink: #ffffff; --danger: #9a2020; --code: #efefec; --ok: #1d6b3a;
}
/*@ Dark */
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131416; --panel: #1c1e21; --ink: #ececec; --muted: #a4a7ab; --line: #3a3d42;
    --accent: #8fb4ff; --accent-ink: #0d1117; --danger: #ff9c9c; --code: #26292d; --ok: #7fd39b;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--bg); color: var(--ink); font: 16px/1.55 system-ui, sans-serif; }
body { margin: 0; }
p, li, dd { text-wrap: pretty; }
h1, h2 { text-wrap: balance; line-height: 1.25; }
h1 { font-size: 1.6rem; margin: 0 0 1rem; }
h2 { font-size: 1.15rem; margin: 2rem 0 .6rem; }
a { color: var(--accent); }
.top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding: .8rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--panel); }
.brand { font-weight: 700; color: var(--ink); text-decoration: none; }
.who { display: flex; align-items: center; gap: .75rem; color: var(--muted); font-size: .9rem; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
main.narrow { max-width: 26rem; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 1.25rem; margin: 1rem 0; }
label { display: block; font-weight: 600; margin: 1rem 0 .3rem; }
.hint { color: var(--muted); font-size: .9rem; margin: .3rem 0 0; }
input[type="email"], input[type="text"], input[type="url"], textarea { display: block; width: 100%; padding: .55rem .65rem; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 5px; }
textarea { min-height: 5.5rem; resize: vertical; font-family: ui-monospace, monospace; font-size: .9rem; }
button { font: inherit; cursor: pointer; padding: .5rem .9rem; border-radius: 5px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
button.danger { color: var(--danger); border-color: var(--danger); }
button.link { border: 0; background: none; padding: 0; color: var(--accent); text-decoration: underline; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.actions { margin-top: 1.1rem; }
.error { color: var(--danger); font-weight: 600; }
.notice { border-left: 4px solid var(--ok); padding-left: .9rem; }
code, pre { font-family: ui-monospace, monospace; font-size: .88rem; background: var(--code); border-radius: 4px; }
code { padding: .1rem .3rem; overflow-wrap: anywhere; }
pre { padding: .8rem; overflow-x: auto; margin: .5rem 0; }
pre code { padding: 0; background: none; overflow-wrap: normal; }
.secret { user-select: all; font-size: 1rem; display: block; padding: .7rem; }
ul.rows { list-style: none; padding: 0; margin: 0; }
ul.rows li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding: .65rem 0; border-top: 1px solid var(--line); }
ul.rows li:first-child { border-top: 0; }
.meta { color: var(--muted); font-size: .9rem; }
.inline { display: flex; gap: .5rem; align-items: flex-end; flex-wrap: wrap; }
.inline .grow { flex: 1 1 14rem; }
.inline label { margin-top: 0; }
`
