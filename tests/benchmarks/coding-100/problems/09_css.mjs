export default [
  { id: 'css-01-grid-holy-grail-areas', lang: 'css', prompt: `CSS: 用 CSS Grid 实现一个 "holy grail" 圣杯布局容器 .layout。要求:
- display 为 grid。
- 用 grid-template-areas 定义三行:第一行 "header header header",中间行 "nav main aside",最后一行 "footer footer footer"。
- grid-template-columns 为 200px 1fr 200px。
- grid-template-rows 为 auto 1fr auto。
- gap 为 16px。
另外为五个子元素分别用 grid-area 指派区域:.header -> header,.nav -> nav,.main -> main,.aside -> aside,.footer -> footer。
只返回 CSS,用 \`\`\`css 包裹,不要解释。`, test: `
const L = decl('.layout','display');
if(L!=='grid')throw 'layout display 必须 grid, got '+L;
const areas = (decl('.layout','grid-template-areas')||'').replace(/\\s+/g,' ');
if(!areas.includes('header header header'))throw 'header row 缺失: '+areas;
if(!areas.includes('nav main aside'))throw 'nav main aside row 缺失: '+areas;
if(!areas.includes('footer footer footer'))throw 'footer row 缺失: '+areas;
const cols = (decl('.layout','grid-template-columns')||'').replace(/\\s+/g,' ');
if(!(cols.includes('200px')&&cols.includes('1fr')))throw 'columns 必须含 200px 和 1fr: '+cols;
if((cols.match(/200px/g)||[]).length<2)throw '需要两个 200px 列: '+cols;
const rows = (decl('.layout','grid-template-rows')||'').replace(/\\s+/g,' ');
if(!(rows.includes('auto')&&rows.includes('1fr')))throw 'rows 必须含 auto 和 1fr: '+rows;
if(!(decl('.layout','gap')||'').includes('16px'))throw 'gap 必须 16px';
const map={'.header':'header','.nav':'nav','.main':'main','.aside':'aside','.footer':'footer'};
for(const k in map){
  const ga = decl(k,'grid-area');
  if(!ga||!ga.includes(map[k]))throw k+' 的 grid-area 必须是 '+map[k]+', got '+ga;
}
`, canonical: `.layout {
  display: grid;
  grid-template-areas:
    "header header header"
    "nav main aside"
    "footer footer footer";
  grid-template-columns: 200px 1fr 200px;
  grid-template-rows: auto 1fr auto;
  gap: 16px;
}
.header { grid-area: header; }
.nav { grid-area: nav; }
.main { grid-area: main; }
.aside { grid-area: aside; }
.footer { grid-area: footer; }` },

  { id: 'css-02-grid-auto-fit-minmax', lang: 'css', prompt: `CSS: 实现一个响应式自动换行卡片网格 .card-grid。
- display 为 grid。
- grid-template-columns 必须用 repeat(auto-fit, minmax(240px, 1fr)) —— 即列宽最小 240px、最大 1fr,空间足够时自动塞更多列、不足时自动换行。
- 行列间距 gap 为 1.5rem。
- align-items 为 start。
只返回 CSS,用 \`\`\`css 包裹,不要解释。`, test: `
if(decl('.card-grid','display')!=='grid')throw 'display 必须 grid';
const cols = (decl('.card-grid','grid-template-columns')||'').replace(/\\s+/g,'');
if(!cols.includes('auto-fit'))throw '必须用 auto-fit: '+cols;
if(!cols.includes('minmax(240px,1fr)'))throw '必须 minmax(240px, 1fr): '+cols;
if(!cols.includes('repeat('))throw '必须用 repeat(): '+cols;
const gap = (decl('.card-grid','gap')||'');
if(!gap.includes('1.5rem'))throw 'gap 必须 1.5rem: '+gap;
if(decl('.card-grid','align-items')!=='start')throw 'align-items 必须 start';
`, canonical: `.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 1.5rem;
  align-items: start;
}` },

  { id: 'css-03-flex-equal-sticky-footer', lang: 'css', prompt: `CSS: 实现一个 "sticky footer"(粘底页脚)布局,使页面内容不足时页脚也贴在视口底部。
- .page:display 为 flex,flex-direction 为 column,min-height 为 100vh。
- .page-main(主体):flex 必须是 "1 0 auto"(即可伸展占满剩余空间、不收缩)。
- .page-footer:flex-shrink 为 0(永不收缩)。
只返回 CSS,用 \`\`\`css 包裹,不要解释。`, test: `
if(decl('.page','display')!=='flex')throw 'page display 必须 flex';
if(decl('.page','flex-direction')!=='column')throw 'flex-direction 必须 column';
if((decl('.page','min-height')||'')!=='100vh')throw 'min-height 必须 100vh';
const f = (decl('.page-main','flex')||'').replace(/\\s+/g,' ').trim();
if(!(f==='1 0 auto'||f.startsWith('1 0 auto')))throw 'page-main flex 必须 1 0 auto, got '+f;
const fs = decl('.page-footer','flex-shrink');
if(fs!=='0')throw 'page-footer flex-shrink 必须 0, got '+fs;
`, canonical: `.page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.page-main { flex: 1 0 auto; }
.page-footer { flex-shrink: 0; }` },

  { id: 'css-04-keyframes-animation-shorthand', lang: 'css', prompt: `CSS: 定义一个名为 spin-pulse 的 @keyframes 动画并应用到 .loader 上。
- @keyframes spin-pulse:0% { transform: rotate(0deg) scale(1); opacity: 1; },50% { transform: rotate(180deg) scale(1.2); opacity: 0.6; },100% { transform: rotate(360deg) scale(1); opacity: 1; }。
- .loader 用 animation 简写,且必须包含:动画名 spin-pulse、时长 1.5s、缓动 ease-in-out、无限循环 infinite。
只返回 CSS,用 \`\`\`css 包裹,不要解释。`, test: `
const k0 = rule('0%');
if(!k0)throw '缺少 0% 关键帧';
const t0 = (k0.decls['transform']||'').replace(/\\s+/g,' ');
if(!(t0.includes('rotate(0deg)')&&t0.includes('scale(1)')))throw '0% transform 错误: '+t0;
if((k0.decls['opacity']||'')!=='1')throw '0% opacity 必须 1';
const k50 = rule('50%');
if(!k50)throw '缺少 50% 关键帧';
const t50 = (k50.decls['transform']||'').replace(/\\s+/g,' ');
if(!(t50.includes('rotate(180deg)')&&t50.includes('scale(1.2)')))throw '50% transform 错误: '+t50;
if((k50.decls['opacity']||'')!=='0.6')throw '50% opacity 必须 0.6';
const k100 = rule('100%');
if(!k100)throw '缺少 100% 关键帧';
if(!(k100.decls['transform']||'').includes('rotate(360deg)'))throw '100% transform 错误';
const anim = (decl('.loader','animation')||'').replace(/\\s+/g,' ');
if(!anim.includes('spin-pulse'))throw 'animation 必须含动画名 spin-pulse: '+anim;
if(!anim.includes('1.5s'))throw 'animation 必须含 1.5s: '+anim;
if(!anim.includes('ease-in-out'))throw 'animation 必须含 ease-in-out: '+anim;
if(!anim.includes('infinite'))throw 'animation 必须含 infinite: '+anim;
`, canonical: `@keyframes spin-pulse {
  0% { transform: rotate(0deg) scale(1); opacity: 1; }
  50% { transform: rotate(180deg) scale(1.2); opacity: 0.6; }
  100% { transform: rotate(360deg) scale(1); opacity: 1; }
}
.loader {
  animation: spin-pulse 1.5s ease-in-out infinite;
}` },

  { id: 'css-05-media-mobile-first-grid-collapse', lang: 'css', prompt: `CSS: 写一个移动优先的响应式布局。
- 基础(无 media query)状态下 .dashboard:display 为 grid,grid-template-columns 为 1fr(单列)。
- 加一个 @media (min-width: 768px) 断点,在其中重定义 .dashboard 的 grid-template-columns 为 repeat(2, 1fr)。
- 再加一个 @media (min-width: 1200px) 断点,在其中重定义 .dashboard 的 grid-template-columns 为 repeat(4, 1fr)。
只返回 CSS,用 \`\`\`css 包裹,不要解释。`, test: `
if(decl('.dashboard','display')!=='grid')throw 'display 必须 grid';
const base = (decl('.dashboard','grid-template-columns')||'').replace(/\\s+/g,'');
if(base!=='1fr')throw '基础列必须 1fr, got '+base;
const hasMq = (re)=>MEDIA.some(m=>re.test(m.replace(/\\s+/g,'')));
if(!hasMq(/min-width:768px/))throw '缺少 min-width:768px 断点; MEDIA='+JSON.stringify(MEDIA);
if(!hasMq(/min-width:1200px/))throw '缺少 min-width:1200px 断点; MEDIA='+JSON.stringify(MEDIA);
const dashCols = RULES.filter(r=>r.sel.includes('.dashboard')).map(r=>(r.decls['grid-template-columns']||'').replace(/\\s+/g,'')).filter(Boolean);
if(!dashCols.some(c=>c.includes('repeat(2,1fr)')))throw '缺少 repeat(2,1fr): '+JSON.stringify(dashCols);
if(!dashCols.some(c=>c.includes('repeat(4,1fr)')))throw '缺少 repeat(4,1fr): '+JSON.stringify(dashCols);
`, canonical: `.dashboard {
  display: grid;
  grid-template-columns: 1fr;
}
@media (min-width: 768px) {
  .dashboard { grid-template-columns: repeat(2, 1fr); }
}
@media (min-width: 1200px) {
  .dashboard { grid-template-columns: repeat(4, 1fr); }
}` },

  { id: 'css-06-var-clamp-fluid-typography', lang: 'css', prompt: `CSS: 实现流式排版 + CSS 变量主题。
- :root 定义三个自定义属性:--brand 为 #3b82f6,--space 为 8px,--ratio 为 1.25。
- .fluid-title:font-size 用 clamp(1.5rem, 4vw + 1rem, 3rem)。
- .fluid-title:color 用 var(--brand)。
- .fluid-title:padding 用 calc(var(--space) * 2)。
- .fluid-title:line-height 用 var(--ratio)。
只返回 CSS,用 \`\`\`css 包裹,不要解释。`, test: `
const root = rule(':root');
if(!root)throw '缺少 :root';
if((root.decls['--brand']||'').replace(/\\s+/g,'').toLowerCase()!=='#3b82f6')throw '--brand 必须 #3b82f6, got '+root.decls['--brand'];
if((root.decls['--space']||'').trim()!=='8px')throw '--space 必须 8px';
if((root.decls['--ratio']||'').trim()!=='1.25')throw '--ratio 必须 1.25';
const fs = (decl('.fluid-title','font-size')||'').replace(/\\s+/g,'');
if(!fs.startsWith('clamp('))throw 'font-size 必须用 clamp(): '+fs;
if(!fs.includes('1.5rem'))throw 'clamp 下限 1.5rem 缺失: '+fs;
if(!fs.includes('3rem'))throw 'clamp 上限 3rem 缺失: '+fs;
if(!(fs.includes('4vw+1rem')||fs.includes('4vw')))throw 'clamp 首选值 4vw + 1rem 缺失: '+fs;
const col = (decl('.fluid-title','color')||'').replace(/\\s+/g,'');
if(!col.includes('var(--brand)'))throw 'color 必须 var(--brand): '+col;
const pad = (decl('.fluid-title','padding')||'').replace(/\\s+/g,'');
if(!(pad.includes('calc(')&&pad.includes('var(--space)')&&pad.includes('2')))throw 'padding 必须 calc(var(--space)*2): '+pad;
if(!(decl('.fluid-title','line-height')||'').includes('var(--ratio)'))throw 'line-height 必须 var(--ratio)';
`, canonical: `:root {
  --brand: #3b82f6;
  --space: 8px;
  --ratio: 1.25;
}
.fluid-title {
  font-size: clamp(1.5rem, 4vw + 1rem, 3rem);
  color: var(--brand);
  padding: calc(var(--space) * 2);
  line-height: var(--ratio);
}` },

  { id: 'css-07-sticky-zindex-stacking', lang: 'css', prompt: `CSS: 实现一个带层叠上下文的粘性导航 + 绝对定位下拉。
- .site-header:position 为 sticky,top 为 0,z-index 为 100,并显式设置 isolation 为 isolate。
- .dropdown-wrap:position 为 relative。
- .dropdown-menu:position 为 absolute,top 为 100%,left 为 0,z-index 为 10。
- .modal-overlay:position 为 fixed,inset 为 0,z-index 为 1000。
只返回 CSS,用 \`\`\`css 包裹,不要解释。`, test: `
if(decl('.site-header','position')!=='sticky')throw 'site-header position 必须 sticky';
if((decl('.site-header','top')||'').trim()!=='0')throw 'site-header top 必须 0';
if((decl('.site-header','z-index')||'').trim()!=='100')throw 'site-header z-index 必须 100';
if((decl('.site-header','isolation')||'').trim()!=='isolate')throw 'site-header 必须 isolation: isolate';
if(decl('.dropdown-wrap','position')!=='relative')throw 'dropdown-wrap position 必须 relative';
if(decl('.dropdown-menu','position')!=='absolute')throw 'dropdown-menu position 必须 absolute';
if(!(decl('.dropdown-menu','top')||'').includes('100%'))throw 'dropdown-menu top 必须 100%';
if((decl('.dropdown-menu','left')||'').trim()!=='0')throw 'dropdown-menu left 必须 0';
if((decl('.dropdown-menu','z-index')||'').trim()!=='10')throw 'dropdown-menu z-index 必须 10';
if(decl('.modal-overlay','position')!=='fixed')throw 'modal-overlay position 必须 fixed';
if((decl('.modal-overlay','inset')||'').trim()!=='0')throw 'modal-overlay inset 必须 0';
if((decl('.modal-overlay','z-index')||'').trim()!=='1000')throw 'modal-overlay z-index 必须 1000';
`, canonical: `.site-header {
  position: sticky;
  top: 0;
  z-index: 100;
  isolation: isolate;
}
.dropdown-wrap { position: relative; }
.dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 10;
}
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
}` },

  { id: 'css-08-pseudo-element-tooltip-arrow', lang: 'css', prompt: `CSS: 用伪元素实现工具提示(tooltip)的小箭头与默认隐藏/悬停显示。
- .tooltip:position 为 relative。
- .tooltip .tip:position 为 absolute,opacity 为 0,visibility 为 hidden,transition 为 "opacity 0.2s ease"。
- .tooltip:hover .tip:opacity 为 1,visibility 为 visible。
- .tooltip .tip::after:content 为 ""(空字符串),position 为 absolute,border-width 为 6px,border-style 为 solid,border-color 为 "transparent transparent #333 transparent"。
只返回 CSS,用 \`\`\`css 包裹,不要解释。`, test: `
if(decl('.tooltip','position')!=='relative')throw '.tooltip position 必须 relative';
const tip = rule('.tooltip .tip');
if(!tip)throw '缺少 .tooltip .tip 规则';
if((tip.decls['position'])!=='absolute')throw '.tip position 必须 absolute';
if((tip.decls['opacity']||'').trim()!=='0')throw '.tip 默认 opacity 必须 0';
if((tip.decls['visibility'])!=='hidden')throw '.tip 默认 visibility 必须 hidden';
if(!(tip.decls['transition']||'').includes('opacity'))throw '.tip transition 必须含 opacity';
const hov = RULES.find(r=>r.sel.includes(':hover')&&r.sel.includes('.tip'));
if(!hov)throw '缺少 .tooltip:hover .tip 规则';
if((hov.decls['opacity']||'').trim()!=='1')throw 'hover 时 opacity 必须 1';
if((hov.decls['visibility'])!=='visible')throw 'hover 时 visibility 必须 visible';
const after = RULES.find(r=>r.sel.includes('::after')&&r.sel.includes('.tip'));
if(!after)throw '缺少 .tip::after 伪元素';
const content = (after.decls['content']||'');
if(!(content==="''"||content==='""'||content.replace(/\\s/g,'')==='""'||content.replace(/\\s/g,'')==="''"))throw 'content 必须为空字符串, got '+content;
if((after.decls['position'])!=='absolute')throw '::after position 必须 absolute';
if(!(after.decls['border-width']||'').includes('6px'))throw '::after border-width 必须 6px';
if((after.decls['border-style'])!=='solid')throw '::after border-style 必须 solid';
const bc = (after.decls['border-color']||'').replace(/\\s+/g,' ').toLowerCase();
if((bc.match(/transparent/g)||[]).length<3)throw '::after border-color 需 3 个 transparent: '+bc;
if(!bc.includes('#333'))throw '::after border-color 需含 #333: '+bc;
`, canonical: `.tooltip { position: relative; }
.tooltip .tip {
  position: absolute;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease;
}
.tooltip:hover .tip {
  opacity: 1;
  visibility: visible;
}
.tooltip .tip::after {
  content: "";
  position: absolute;
  border-width: 6px;
  border-style: solid;
  border-color: transparent transparent #333 transparent;
}` },

  { id: 'css-09-grid-named-lines-span', lang: 'css', prompt: `CSS: 用 Grid 命名网格线 + 跨列/跨行精确放置。
- .app:display 为 grid。
- grid-template-columns 用命名线:[sidebar-start] 240px [sidebar-end content-start] 1fr [content-end]。
- grid-template-rows 为 [top] 64px [mid] 1fr [bottom]。
- .app-sidebar:grid-column 为 "sidebar-start / sidebar-end",grid-row 为 "top / bottom"。
- .app-content:grid-column 为 "content-start / content-end"。
- .app-banner:grid-column 必须用 span 语法,值为 "1 / span 2"。
只返回 CSS,用 \`\`\`css 包裹,不要解释。`, test: `
if(decl('.app','display')!=='grid')throw '.app display 必须 grid';
const cols = (decl('.app','grid-template-columns')||'').replace(/\\s+/g,' ');
if(!cols.includes('[sidebar-start]'))throw 'columns 缺少 [sidebar-start]: '+cols;
if(!cols.includes('[content-end]'))throw 'columns 缺少 [content-end]: '+cols;
if(!(cols.includes('240px')&&cols.includes('1fr')))throw 'columns 缺少 240px/1fr: '+cols;
const rows = (decl('.app','grid-template-rows')||'').replace(/\\s+/g,' ');
if(!(rows.includes('[top]')&&rows.includes('[bottom]')))throw 'rows 缺少命名线: '+rows;
const sgc = (decl('.app-sidebar','grid-column')||'').replace(/\\s+/g,'');
if(!(sgc.includes('sidebar-start')&&sgc.includes('sidebar-end')))throw 'sidebar grid-column 错误: '+sgc;
const sgr = (decl('.app-sidebar','grid-row')||'').replace(/\\s+/g,'');
if(!(sgr.includes('top')&&sgr.includes('bottom')))throw 'sidebar grid-row 错误: '+sgr;
const cgc = (decl('.app-content','grid-column')||'').replace(/\\s+/g,'');
if(!(cgc.includes('content-start')&&cgc.includes('content-end')))throw 'content grid-column 错误: '+cgc;
const bgc = (decl('.app-banner','grid-column')||'').replace(/\\s+/g,'');
if(!bgc.includes('span2'))throw 'banner grid-column 必须含 span 2: '+bgc;
`, canonical: `.app {
  display: grid;
  grid-template-columns: [sidebar-start] 240px [sidebar-end content-start] 1fr [content-end];
  grid-template-rows: [top] 64px [mid] 1fr [bottom];
}
.app-sidebar {
  grid-column: sidebar-start / sidebar-end;
  grid-row: top / bottom;
}
.app-content { grid-column: content-start / content-end; }
.app-banner { grid-column: 1 / span 2; }` },

  { id: 'css-10-specificity-nth-not-transition', lang: 'css', prompt: `CSS: 复杂选择器 + 结构性伪类 + 多属性过渡。
- .list > li:nth-child(odd):background 为 #f5f5f5。
- .list > li:not(:last-child):border-bottom 为 "1px solid #e0e0e0"。
- .list li:nth-of-type(3n+1):font-weight 为 bold。
- .btn:not([disabled]):hover:transform 为 translateY(-2px)。
- .btn:必须有 transition,值为 "transform 0.15s ease, box-shadow 0.15s ease"。
只返回 CSS,用 \`\`\`css 包裹,不要解释。`, test: `
const odd = RULES.find(r=>r.sel.replace(/\\s+/g,'').includes('.list>li:nth-child(odd)'));
if(!odd)throw '缺少 .list > li:nth-child(odd) 规则; sels='+JSON.stringify(RULES.map(r=>r.sel));
if(!(odd.decls['background']||'').toLowerCase().includes('#f5f5f5'))throw 'odd background 必须 #f5f5f5';
const notlast = RULES.find(r=>{const s=r.sel.replace(/\\s+/g,'');return s.includes('.list>li:not(:last-child)');});
if(!notlast)throw '缺少 .list > li:not(:last-child) 规则';
if(!(notlast.decls['border-bottom']||'').replace(/\\s+/g,' ').includes('1px solid'))throw 'not(:last-child) border-bottom 错误';
const nth = RULES.find(r=>r.sel.replace(/\\s+/g,'').includes('li:nth-of-type(3n+1)'));
if(!nth)throw '缺少 li:nth-of-type(3n+1) 规则';
if((nth.decls['font-weight'])!=='bold')throw 'nth-of-type(3n+1) font-weight 必须 bold';
const btnHover = RULES.find(r=>{const s=r.sel.replace(/\\s+/g,'');return s.includes('.btn:not([disabled]):hover')||(s.includes('.btn')&&s.includes(':not([disabled])')&&s.includes(':hover'));});
if(!btnHover)throw '缺少 .btn:not([disabled]):hover 规则';
if(!(btnHover.decls['transform']||'').replace(/\\s+/g,'').toLowerCase().includes('translatey(-2px)'))throw 'hover transform 必须 translateY(-2px): '+btnHover.decls['transform'];
const btn = RULES.find(r=>{const s=r.sel.replace(/\\s+/g,'');return s==='.btn'||(s.includes('.btn')&&!s.includes(':'));});
const trans = (btn&&btn.decls['transition'])||decl('.btn','transition')||'';
const t = trans.replace(/\\s+/g,' ');
if(!(t.includes('transform')&&t.includes('box-shadow')))throw '.btn transition 必须同时过渡 transform 和 box-shadow: '+t;
`, canonical: `.list > li:nth-child(odd) {
  background: #f5f5f5;
}
.list > li:not(:last-child) {
  border-bottom: 1px solid #e0e0e0;
}
.list li:nth-of-type(3n+1) {
  font-weight: bold;
}
.btn:not([disabled]):hover {
  transform: translateY(-2px);
}
.btn {
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}` }
];
