/**
 * The gate page. Fully self-contained: it never loads a byte of the game,
 * because nothing behind the password should be reachable before the password
 * is given.
 */

const LOCK_ICON = `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM140,148.94V172a12,12,0,0,1-24,0V148.94a20,20,0,1,1,24,0Z"></path></svg>`;

const WARN_ICON = `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M240.26,186.1,152.81,34.23h0a28.74,28.74,0,0,0-49.62,0L15.74,186.1a27.45,27.45,0,0,0,0,27.71A28.31,28.31,0,0,0,40.55,228h174.9a28.31,28.31,0,0,0,24.79-14.19A27.45,27.45,0,0,0,240.26,186.1ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z"></path></svg>`;

export function gatePage(opts: { error?: string; misconfigured?: boolean }): string {
  const { error, misconfigured } = opts;
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#07070c">
<title>OPUS RACING — Restricted</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#07070c; --ink:#f2f3f8; --dim:#7f8496; --line:rgba(255,255,255,.10);
  --accent:#ff2d55; --accent2:#00e5ff;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,"Cascadia Mono","Roboto Mono",Menlo,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
}
html,body{height:100%}
body{
  background:var(--bg); color:var(--ink); font-family:var(--sans);
  display:grid; place-items:center; padding:24px;
  overflow:hidden; -webkit-font-smoothing:antialiased;
}
/* Two slow-drifting radial washes + a perspective grid. All GPU, no JS. */
.bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.bg::before,.bg::after{
  content:"";position:absolute;width:120vmax;height:120vmax;border-radius:50%;
  filter:blur(90px);opacity:.30;will-change:transform;
}
.bg::before{background:radial-gradient(circle,var(--accent),transparent 62%);top:-58vmax;left:-32vmax;animation:d1 26s ease-in-out infinite alternate}
.bg::after{background:radial-gradient(circle,var(--accent2),transparent 62%);bottom:-62vmax;right:-34vmax;animation:d2 31s ease-in-out infinite alternate}
@keyframes d1{to{transform:translate3d(14vmax,10vmax,0) scale(1.14)}}
@keyframes d2{to{transform:translate3d(-12vmax,-8vmax,0) scale(1.1)}}
.grid{
  position:fixed;left:50%;bottom:-10vh;width:300vw;height:70vh;z-index:0;
  transform:translateX(-50%) perspective(46vh) rotateX(66deg);
  background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:64px 64px;
  -webkit-mask-image:linear-gradient(to top,#000 4%,transparent 72%);
          mask-image:linear-gradient(to top,#000 4%,transparent 72%);
  animation:scroll 2.4s linear infinite;pointer-events:none;
}
@keyframes scroll{to{background-position:0 64px}}

main{position:relative;z-index:1;width:min(420px,100%)}
.card{
  background:rgba(13,14,20,.74); backdrop-filter:blur(22px) saturate(150%);
  -webkit-backdrop-filter:blur(22px) saturate(150%);
  border:1px solid var(--line); border-radius:20px; padding:38px 32px 30px;
  box-shadow:0 40px 90px -30px rgba(0,0,0,.95), inset 0 1px 0 rgba(255,255,255,.06);
}
.lock{
  width:54px;height:54px;display:grid;place-items:center;margin:0 auto 20px;
  border-radius:15px;border:1px solid var(--line);
  background:linear-gradient(160deg,rgba(255,45,85,.16),rgba(0,229,255,.10));
  color:var(--ink);
}
.lock svg{width:26px;height:26px}
h1{
  font-family:var(--mono);font-size:19px;font-weight:600;letter-spacing:.34em;
  text-align:center;text-transform:uppercase;margin-bottom:7px;
}
.sub{text-align:center;color:var(--dim);font-size:12.5px;letter-spacing:.10em;
  text-transform:uppercase;font-family:var(--mono);margin-bottom:26px}
label{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.22em;
  color:var(--dim);text-transform:uppercase;margin-bottom:9px}
input{
  width:100%;padding:14px 15px;border-radius:11px;border:1px solid var(--line);
  background:rgba(0,0,0,.5);color:var(--ink);font-family:var(--mono);
  font-size:16px;letter-spacing:.16em;outline:none;transition:border-color .18s,box-shadow .18s;
}
input:focus{border-color:rgba(255,45,85,.65);box-shadow:0 0 0 3px rgba(255,45,85,.14)}
button{
  width:100%;margin-top:16px;padding:14px;border:0;border-radius:11px;cursor:pointer;
  background:linear-gradient(96deg,var(--accent),#ff5c3a);color:#fff;
  font-family:var(--mono);font-size:12.5px;font-weight:600;letter-spacing:.24em;
  text-transform:uppercase;transition:transform .12s,filter .18s,opacity .18s;
}
button:hover{filter:brightness(1.1)}
button:active{transform:translateY(1px)}
button[disabled]{opacity:.55;cursor:default}
.err{
  display:flex;gap:9px;align-items:center;margin-top:15px;padding:11px 13px;
  border-radius:10px;border:1px solid rgba(255,45,85,.34);background:rgba(255,45,85,.09);
  color:#ffb3c1;font-size:12.5px;line-height:1.45;
}
.err svg{width:16px;height:16px;flex:none}
.foot{margin-top:22px;text-align:center;font-family:var(--mono);font-size:10px;
  letter-spacing:.2em;color:#4d5265;text-transform:uppercase}
@media (prefers-reduced-motion:reduce){
  .bg::before,.bg::after,.grid{animation:none}
}
</style>
</head>
<body>
<div class="bg"></div><div class="grid"></div>
<main>
  <form class="card" method="POST" action="/api/login" id="f">
    <div class="lock">${LOCK_ICON}</div>
    <h1>Opus Racing</h1>
    <p class="sub">Private circuit · access key required</p>
    <label for="p">Access key</label>
    <input id="p" name="password" type="password" autocomplete="current-password"
           autofocus required ${misconfigured ? "disabled" : ""} placeholder="••••••••••">
    <button type="submit" id="b" ${misconfigured ? "disabled" : ""}>Enter the paddock</button>
    ${
      misconfigured
        ? `<div class="err">${WARN_ICON}<span>No <code>APP_PASSWORD</code> is configured for this deployment. Add it in the Cloudflare Pages project settings, then redeploy.</span></div>`
        : error
          ? `<div class="err">${WARN_ICON}<span>${error}</span></div>`
          : ""
    }
    <p class="foot">Cloudflare Pages · Durable Objects</p>
  </form>
</main>
<script>
// Progressive enhancement: post as JSON so a wrong key re-renders in place
// instead of a full navigation. The plain form POST still works without JS.
var f=document.getElementById('f'),b=document.getElementById('b'),p=document.getElementById('p');
f.addEventListener('submit',function(e){
  if(!window.fetch)return;
  e.preventDefault(); b.disabled=true; b.textContent='Checking…';
  fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({password:p.value})})
   .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
   .then(function(res){
     if(res.ok){location.replace('/');return}
     b.disabled=false; b.textContent='Enter the paddock';
     var old=document.querySelector('.err'); if(old)old.remove();
     var d=document.createElement('div'); d.className='err';
     d.innerHTML=${JSON.stringify(WARN_ICON)}+'<span></span>';
     d.querySelector('span').textContent=res.j.error||'Incorrect access key.';
     f.appendChild(d); p.select();
   })
   .catch(function(){ b.disabled=false; b.textContent='Enter the paddock'; });
});
</script>
</body>
</html>`;
}
