export default [
  {
    id: 'html-01-disclosure-nav',
    lang: 'html',
    prompt: `HTML 可访问的导航折叠菜单(disclosure pattern)。要求严格满足:
1. 顶层 <nav>,带 aria-label="主导航"。
2. nav 内第一个子元素是一个 <button>,文本含"产品",并且:type="button"、aria-expanded="false"、aria-controls="products-menu"。
3. button 之后紧跟一个 <ul>,其 id="products-menu"。
4. 该 ul 内恰好 3 个 <li>,每个 li 内含一个 <a href> 且 href 非空(不为 "#")。
只返回 HTML,用 \`\`\`html 包裹,不要解释。`,
    test: `
const nav = $('nav[aria-label="主导航"]');
if(!nav) throw 'missing nav with aria-label=主导航';
const btn = nav.querySelector(':scope > button');
if(!btn) throw 'nav first-level button missing';
if(btn.getAttribute('type')!=='button') throw 'button type must be button';
if(!/产品/.test(btn.textContent)) throw 'button text must contain 产品';
if(btn.getAttribute('aria-expanded')!=='false') throw 'aria-expanded must be false';
if(btn.getAttribute('aria-controls')!=='products-menu') throw 'aria-controls must be products-menu';
const ul = $('#products-menu');
if(!ul || ul.tagName.toLowerCase()!=='ul') throw 'ul#products-menu missing';
if(ul.previousElementSibling !== btn) throw 'ul must immediately follow the button';
const lis = ul.querySelectorAll(':scope > li');
if(lis.length!==3) throw 'expected exactly 3 li, got '+lis.length;
lis.forEach((li,i)=>{
  const a = li.querySelector('a[href]');
  if(!a) throw 'li '+i+' missing a[href]';
  const h = a.getAttribute('href');
  if(!h || h==='#') throw 'li '+i+' href must be non-empty and not #';
});
`,
    canonical: `<nav aria-label="主导航">
  <button type="button" aria-expanded="false" aria-controls="products-menu">产品</button>
  <ul id="products-menu">
    <li><a href="/laptops">笔记本</a></li>
    <li><a href="/phones">手机</a></li>
    <li><a href="/tablets">平板</a></li>
  </ul>
</nav>`
  },
  {
    id: 'html-02-accessible-form',
    lang: 'html',
    prompt: `HTML 可访问的注册表单片段。要求:
1. 一个 <form>。
2. 邮箱字段:<label> 用 for="email" 关联到 <input id="email">,input 的 type="email"、name="email"、required,且通过 aria-describedby="email-hint" 关联到一个 id="email-hint" 的提示元素(提示元素文本非空)。
3. 密码字段:<label for="pwd"> 关联 <input id="pwd">,type="password"、name="password"、required、minlength="8"。
4. 一个 type="submit" 的提交按钮。
注意:label 必须真实存在且 for 值与对应 input 的 id 完全一致。只返回 HTML,用 \`\`\`html 包裹,不要解释。`,
    test: `
if(!$('form')) throw 'missing form';
const le = $('label[for="email"]');
if(!le) throw 'missing label[for=email]';
const email = $('input#email');
if(!email) throw 'missing input#email';
if(email.getAttribute('type')!=='email') throw 'email input type must be email';
if(email.getAttribute('name')!=='email') throw 'email name must be email';
if(!email.hasAttribute('required')) throw 'email must be required';
const db = email.getAttribute('aria-describedby');
if(db!=='email-hint') throw 'email aria-describedby must be email-hint';
const hint = $('#email-hint');
if(!hint) throw 'missing #email-hint';
if(!hint.textContent.trim()) throw 'email-hint must have text';
const lp = $('label[for="pwd"]');
if(!lp) throw 'missing label[for=pwd]';
const pwd = $('input#pwd');
if(!pwd) throw 'missing input#pwd';
if(pwd.getAttribute('type')!=='password') throw 'pwd type must be password';
if(pwd.getAttribute('name')!=='password') throw 'pwd name must be password';
if(!pwd.hasAttribute('required')) throw 'pwd must be required';
if(pwd.getAttribute('minlength')!=='8') throw 'pwd minlength must be 8';
const submit = $('button[type="submit"], input[type="submit"]');
if(!submit) throw 'missing submit control';
`,
    canonical: `<form>
  <label for="email">电子邮箱</label>
  <input id="email" type="email" name="email" required aria-describedby="email-hint">
  <p id="email-hint">我们不会公开你的邮箱。</p>

  <label for="pwd">密码</label>
  <input id="pwd" type="password" name="password" required minlength="8">

  <button type="submit">注册</button>
</form>`
  },
  {
    id: 'html-03-data-table-scope',
    lang: 'html',
    prompt: `HTML 可访问的数据表。要求:
1. 一个 <table>,含 <caption>,caption 文本包含"季度销售"。
2. <thead> 内一个表头行,含恰好 3 个 <th scope="col">。
3. <tbody> 内恰好 2 个数据行 <tr>;每个数据行的第一个单元格是 <th scope="row">,其余 2 个单元格为 <td>。
即:tbody 内总共应有 2 个 th[scope=row] 和 4 个 td。只返回 HTML,用 \`\`\`html 包裹,不要解释。`,
    test: `
const t = $('table');
if(!t) throw 'missing table';
const cap = t.querySelector('caption');
if(!cap) throw 'missing caption';
if(!/季度销售/.test(cap.textContent)) throw 'caption must contain 季度销售';
const colth = $$('table thead th[scope="col"]');
if(colth.length!==3) throw 'expected 3 th[scope=col], got '+colth.length;
const bodyRows = $$('table tbody > tr');
if(bodyRows.length!==2) throw 'expected 2 tbody rows, got '+bodyRows.length;
const rowth = $$('table tbody th[scope="row"]');
if(rowth.length!==2) throw 'expected 2 th[scope=row], got '+rowth.length;
bodyRows.forEach((r,i)=>{
  const first = r.firstElementChild;
  if(!first || first.tagName.toLowerCase()!=='th' || first.getAttribute('scope')!=='row')
    throw 'row '+i+' first cell must be th[scope=row]';
  const tds = r.querySelectorAll('td');
  if(tds.length!==2) throw 'row '+i+' must have 2 td, got '+tds.length;
});
`,
    canonical: `<table>
  <caption>2025 各区域季度销售</caption>
  <thead>
    <tr>
      <th scope="col">区域</th>
      <th scope="col">Q1</th>
      <th scope="col">Q2</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">华东</th>
      <td>120</td>
      <td>150</td>
    </tr>
    <tr>
      <th scope="row">华南</th>
      <td>98</td>
      <td>110</td>
    </tr>
  </tbody>
</table>`
  },
  {
    id: 'html-04-landmarks',
    lang: 'html',
    prompt: `HTML 页面 landmark 骨架。要求:
1. <body> 直接子级依次包含:<header>、<nav>、<main>、<aside>、<footer>。
2. <header> 内含一个 <h1>。
3. <nav> 必须带 aria-label,其内含一个 <ul>。
4. <main> 内含一个 <article>,article 内含 <h2>。
5. <aside> 必须带 aria-label。
6. 页面中 <main> 元素只能出现 1 个。
只返回 HTML(可省略 doctype/html/head,但 body 结构需如上),用 \`\`\`html 包裹,不要解释。`,
    test: `
const order = ['header','nav','main','aside','footer'];
order.forEach(t=>{ if(!$(t)) throw 'missing '+t; });
if($$('main').length!==1) throw 'must have exactly 1 main';
if(!$('header h1')) throw 'header must contain h1';
const nav = $('nav');
if(!nav.getAttribute('aria-label')) throw 'nav must have aria-label';
if(!nav.querySelector('ul')) throw 'nav must contain ul';
if(!$('main > article')) throw 'main must contain article';
if(!$('main article h2')) throw 'article must contain h2';
const aside = $('aside');
if(!aside.getAttribute('aria-label')) throw 'aside must have aria-label';
const els = order.map(t=>$(t));
for(let i=0;i<els.length-1;i++){
  const pos = els[i].compareDocumentPosition(els[i+1]);
  if(!(pos & 4)) throw order[i]+' must come before '+order[i+1];
}
`,
    canonical: `<header>
  <h1>开发者文档</h1>
</header>
<nav aria-label="主导航">
  <ul>
    <li><a href="/guide">指南</a></li>
    <li><a href="/api">API</a></li>
  </ul>
</nav>
<main>
  <article>
    <h2>快速开始</h2>
    <p>安装并运行。</p>
  </article>
</main>
<aside aria-label="相关链接">
  <ul>
    <li><a href="/faq">常见问题</a></li>
  </ul>
</aside>
<footer>
  <p>版权所有</p>
</footer>`
  },
  {
    id: 'html-05-tablist',
    lang: 'html',
    prompt: `HTML 可访问的 Tabs(WAI-ARIA tablist 模式)静态结构。要求:
1. 一个容器,内含一个 role="tablist" 的元素,带 aria-label。
2. tablist 内恰好 3 个 role="tab" 的 <button>,每个 tab:有唯一 id、有 aria-controls 指向其面板的 id、有 aria-selected("true"/"false")。其中第一个 tab aria-selected="true"、tabindex="0";其余两个 aria-selected="false"、tabindex="-1"。
3. 对应 3 个 role="tabpanel" 的元素,每个:有自己的 id(与某个 tab 的 aria-controls 一致)、有 aria-labelledby 指向对应 tab 的 id。
4. 第一个 tabpanel 可见,其余两个带 hidden 属性。
只返回 HTML,用 \`\`\`html 包裹,不要解释。`,
    test: `
const tl = $('[role="tablist"]');
if(!tl) throw 'missing role=tablist';
if(!tl.getAttribute('aria-label')) throw 'tablist needs aria-label';
const tabs = $$('[role="tablist"] button[role="tab"]');
if(tabs.length!==3) throw 'expected 3 role=tab buttons, got '+tabs.length;
const ids = new Set();
let selectedCount = 0;
tabs.forEach((t,i)=>{
  const id = t.getAttribute('id');
  if(!id) throw 'tab '+i+' missing id';
  if(ids.has(id)) throw 'duplicate tab id '+id;
  ids.add(id);
  const ctl = t.getAttribute('aria-controls');
  if(!ctl) throw 'tab '+i+' missing aria-controls';
  const sel = t.getAttribute('aria-selected');
  if(sel!=='true' && sel!=='false') throw 'tab '+i+' aria-selected must be true/false';
  if(sel==='true') selectedCount++;
  const panel = $('#'+ctl);
  if(!panel) throw 'panel #'+ctl+' not found for tab '+i;
  if(panel.getAttribute('role')!=='tabpanel') throw 'controlled element must be role=tabpanel';
  if(panel.getAttribute('aria-labelledby')!==id) throw 'panel aria-labelledby must equal tab id';
});
if(selectedCount!==1) throw 'exactly one tab must be aria-selected=true, got '+selectedCount;
if(tabs[0].getAttribute('aria-selected')!=='true') throw 'first tab must be selected';
if(tabs[0].getAttribute('tabindex')!=='0') throw 'first tab tabindex must be 0';
if(tabs[1].getAttribute('tabindex')!=='-1' || tabs[2].getAttribute('tabindex')!=='-1') throw 'inactive tabs tabindex must be -1';
const panels = $$('[role="tabpanel"]');
if(panels.length!==3) throw 'expected 3 tabpanels, got '+panels.length;
if(panels[0].hasAttribute('hidden')) throw 'first panel must be visible';
if(!panels[1].hasAttribute('hidden') || !panels[2].hasAttribute('hidden')) throw 'other panels must be hidden';
`,
    canonical: `<div class="tabs">
  <div role="tablist" aria-label="账户设置">
    <button role="tab" id="tab-1" aria-controls="panel-1" aria-selected="true" tabindex="0">资料</button>
    <button role="tab" id="tab-2" aria-controls="panel-2" aria-selected="false" tabindex="-1">安全</button>
    <button role="tab" id="tab-3" aria-controls="panel-3" aria-selected="false" tabindex="-1">通知</button>
  </div>
  <div role="tabpanel" id="panel-1" aria-labelledby="tab-1">
    <p>资料内容</p>
  </div>
  <div role="tabpanel" id="panel-2" aria-labelledby="tab-2" hidden>
    <p>安全内容</p>
  </div>
  <div role="tabpanel" id="panel-3" aria-labelledby="tab-3" hidden>
    <p>通知内容</p>
  </div>
</div>`
  },
  {
    id: 'html-06-modal-dialog',
    lang: 'html',
    prompt: `HTML 可访问的模态对话框结构。要求:
1. 一个 <div role="dialog">,带 aria-modal="true",并通过 aria-labelledby 指向标题元素的 id、通过 aria-describedby 指向描述元素的 id。
2. 对话框内:一个标题元素(其 id 与 aria-labelledby 一致,标签是 h2),一段描述(其 id 与 aria-describedby 一致),以及两个按钮:一个文本含"确认"、一个文本含"取消",二者都是 type="button"。
3. 必须有一个明确的关闭按钮 <button> 带 aria-label="关闭"。
只返回 HTML,用 \`\`\`html 包裹,不要解释。`,
    test: `
const d = $('[role="dialog"]');
if(!d) throw 'missing role=dialog';
if(d.getAttribute('aria-modal')!=='true') throw 'aria-modal must be true';
const lb = d.getAttribute('aria-labelledby');
if(!lb) throw 'dialog needs aria-labelledby';
const title = $('#'+lb);
if(!title) throw 'labelledby target not found';
if(title.tagName.toLowerCase()!=='h2') throw 'title must be h2';
if(!title.textContent.trim()) throw 'title must have text';
const db = d.getAttribute('aria-describedby');
if(!db) throw 'dialog needs aria-describedby';
const desc = $('#'+db);
if(!desc) throw 'describedby target not found';
if(!desc.textContent.trim()) throw 'description must have text';
const btns = $$('[role="dialog"] button');
const confirm = btns.find(b=>/确认/.test(b.textContent) && b.getAttribute('type')==='button');
if(!confirm) throw 'missing 确认 button[type=button]';
const cancel = btns.find(b=>/取消/.test(b.textContent) && b.getAttribute('type')==='button');
if(!cancel) throw 'missing 取消 button[type=button]';
const close = btns.find(b=>b.getAttribute('aria-label')==='关闭');
if(!close) throw 'missing close button with aria-label=关闭';
`,
    canonical: `<div role="dialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-desc">
  <button type="button" aria-label="关闭">&times;</button>
  <h2 id="dlg-title">删除确认</h2>
  <p id="dlg-desc">此操作不可撤销,确定要删除该项目吗?</p>
  <button type="button">确认</button>
  <button type="button">取消</button>
</div>`
  },
  {
    id: 'html-07-figure-details',
    lang: 'html',
    prompt: `HTML 语义化富内容片段。要求:
1. 一个 <figure>,内含一个 <img>(必须有非空 alt 属性)和一个 <figcaption>(文本非空),且 figcaption 必须是 figure 的最后一个子元素。
2. 紧随 figure 之后是一个 <details>,其第一个子元素必须是 <summary>(summary 文本非空)。details 不带 open 属性。
3. <details> 内、summary 之后,含一个 <table> 简表:至少 1 个 <th scope="col">。
注意嵌套与顺序严格。只返回 HTML,用 \`\`\`html 包裹,不要解释。`,
    test: `
const fig = $('figure');
if(!fig) throw 'missing figure';
const img = fig.querySelector('img');
if(!img) throw 'figure must contain img';
const alt = img.getAttribute('alt');
if(alt===null || alt.trim()==='') throw 'img must have non-empty alt';
const cap = fig.querySelector('figcaption');
if(!cap) throw 'figure must contain figcaption';
if(!cap.textContent.trim()) throw 'figcaption must have text';
if(fig.lastElementChild !== cap) throw 'figcaption must be last child of figure';
const det = $('details');
if(!det) throw 'missing details';
if(fig.nextElementSibling !== det) throw 'details must immediately follow figure';
if(det.hasAttribute('open')) throw 'details must not have open attribute';
const sum = det.firstElementChild;
if(!sum || sum.tagName.toLowerCase()!=='summary') throw 'first child of details must be summary';
if(!sum.textContent.trim()) throw 'summary must have text';
const th = det.querySelector('table th[scope="col"]');
if(!th) throw 'details must contain a table with th[scope=col]';
`,
    canonical: `<figure>
  <img src="/chart.png" alt="2025 年月度增长折线图">
  <figcaption>图 1:月度活跃用户增长趋势</figcaption>
</figure>
<details>
  <summary>查看原始数据</summary>
  <table>
    <thead>
      <tr><th scope="col">月份</th><th scope="col">活跃用户</th></tr>
    </thead>
    <tbody>
      <tr><td>1月</td><td>1200</td></tr>
    </tbody>
  </table>
</details>`
  },
  {
    id: 'html-08-combobox',
    lang: 'html',
    prompt: `HTML 可访问的自动补全组合框(ARIA 1.2 combobox 模式)静态结构。要求:
1. 一个 <label> 用 for 关联到输入框 id="city-input"。
2. 输入框 <input id="city-input">:type="text"、role="combobox"、aria-expanded="true"、aria-autocomplete="list"、aria-controls 指向列表框 id="city-listbox"、aria-activedescendant 指向当前高亮项 id="city-opt-2"。
3. 一个 role="listbox" 的 <ul id="city-listbox">,内含恰好 3 个 role="option" 的 <li>,id 分别为 city-opt-1 / city-opt-2 / city-opt-3。
4. 被 aria-activedescendant 引用的那个 option(city-opt-2)必须带 aria-selected="true",其余两个不得为 true。
只返回 HTML,用 \`\`\`html 包裹,不要解释。`,
    test: `
const inp = $('input#city-input');
if(!inp) throw 'missing input#city-input';
if(inp.getAttribute('type')!=='text') throw 'input type must be text';
if(inp.getAttribute('role')!=='combobox') throw 'input role must be combobox';
if(inp.getAttribute('aria-expanded')!=='true') throw 'aria-expanded must be true';
if(inp.getAttribute('aria-autocomplete')!=='list') throw 'aria-autocomplete must be list';
if(inp.getAttribute('aria-controls')!=='city-listbox') throw 'aria-controls must be city-listbox';
const ad = inp.getAttribute('aria-activedescendant');
if(ad!=='city-opt-2') throw 'aria-activedescendant must be city-opt-2';
const lbl = $('label[for="city-input"]');
if(!lbl) throw 'missing label[for=city-input]';
const lb = $('ul#city-listbox[role="listbox"]');
if(!lb) throw 'missing ul#city-listbox[role=listbox]';
const opts = $$('#city-listbox > li[role="option"]');
if(opts.length!==3) throw 'expected 3 role=option li, got '+opts.length;
const expectIds = ['city-opt-1','city-opt-2','city-opt-3'];
opts.forEach((o,i)=>{ if(o.getAttribute('id')!==expectIds[i]) throw 'option '+i+' id must be '+expectIds[i]; });
const active = $('#'+ad);
if(!active) throw 'activedescendant target not found';
if(active.getAttribute('aria-selected')!=='true') throw 'active option must be aria-selected=true';
opts.forEach(o=>{
  if(o.getAttribute('id')!==ad && o.getAttribute('aria-selected')==='true') throw 'only the active option may be aria-selected=true';
});
`,
    canonical: `<label for="city-input">选择城市</label>
<input id="city-input" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="city-listbox" aria-activedescendant="city-opt-2">
<ul id="city-listbox" role="listbox">
  <li id="city-opt-1" role="option">北京</li>
  <li id="city-opt-2" role="option" aria-selected="true">上海</li>
  <li id="city-opt-3" role="option">广州</li>
</ul>`
  },
  {
    id: 'html-09-fieldset-radiogroup',
    lang: 'html',
    prompt: `HTML 可访问的单选分组表单。要求:
1. 一个 <form>。
2. form 内一个 <fieldset>,其第一个子元素是 <legend>(文本含"配送方式")。
3. fieldset 内恰好 3 组单选:每组一个 <input type="radio">,共享同一 name="shipping",各自有唯一 id 和唯一 value,且每个 radio 都有一个 <label> 通过 for 关联到该 radio 的 id。
4. 3 个 radio 中恰好 1 个带 checked 属性。
5. 另有一个 fieldset>legend 文本含"附加选项",内含至少 1 个 <input type="checkbox">,该 checkbox 也必须有 <label for> 关联。
即:页面应有 2 个 fieldset,各自的第一个子元素都是 legend。只返回 HTML,用 \`\`\`html 包裹,不要解释。`,
    test: `
if(!$('form')) throw 'missing form';
const fsets = $$('form fieldset');
if(fsets.length!==2) throw 'expected 2 fieldset, got '+fsets.length;
fsets.forEach((fs,i)=>{
  const first = fs.firstElementChild;
  if(!first || first.tagName.toLowerCase()!=='legend') throw 'fieldset '+i+' first child must be legend';
});
const ship = fsets.find(fs=>/配送方式/.test(fs.querySelector('legend').textContent));
if(!ship) throw 'missing fieldset with legend 配送方式';
const radios = ship.querySelectorAll('input[type="radio"]');
if(radios.length!==3) throw 'expected 3 radio in shipping fieldset, got '+radios.length;
const ids = new Set(), vals = new Set();
let checked = 0;
radios.forEach((r,i)=>{
  if(r.getAttribute('name')!=='shipping') throw 'radio '+i+' name must be shipping';
  const id = r.getAttribute('id');
  if(!id) throw 'radio '+i+' missing id';
  if(ids.has(id)) throw 'duplicate radio id '+id;
  ids.add(id);
  const v = r.getAttribute('value');
  if(!v) throw 'radio '+i+' missing value';
  if(vals.has(v)) throw 'duplicate radio value '+v;
  vals.add(v);
  if(!$('label[for="'+id+'"]')) throw 'radio '+i+' missing associated label[for='+id+']';
  if(r.hasAttribute('checked')) checked++;
});
if(checked!==1) throw 'exactly one radio must be checked, got '+checked;
const extra = fsets.find(fs=>/附加选项/.test(fs.querySelector('legend').textContent));
if(!extra) throw 'missing fieldset with legend 附加选项';
const cb = extra.querySelector('input[type="checkbox"]');
if(!cb) throw 'extra fieldset must contain a checkbox';
const cbid = cb.getAttribute('id');
if(!cbid) throw 'checkbox missing id';
if(!$('label[for="'+cbid+'"]')) throw 'checkbox missing associated label';
`,
    canonical: `<form>
  <fieldset>
    <legend>配送方式</legend>
    <input type="radio" id="ship-std" name="shipping" value="standard" checked>
    <label for="ship-std">标准配送</label>
    <input type="radio" id="ship-exp" name="shipping" value="express">
    <label for="ship-exp">加急配送</label>
    <input type="radio" id="ship-pick" name="shipping" value="pickup">
    <label for="ship-pick">到店自提</label>
  </fieldset>
  <fieldset>
    <legend>附加选项</legend>
    <input type="checkbox" id="gift-wrap" name="giftwrap" value="yes">
    <label for="gift-wrap">礼品包装</label>
  </fieldset>
</form>`
  },
  {
    id: 'html-10-breadcrumb-skiplink',
    lang: 'html',
    prompt: `HTML 可访问的页面顶部结构:跳转链接 + 面包屑 + 标题层级。要求:
1. 文档最前面一个"跳到主内容"链接 <a href="#main-content">,文本非空。
2. 一个 <nav aria-label="面包屑">,其内是一个有序列表 <ol>,含恰好 3 个 <li>:前两个 li 各含一个 <a href>(href 非空且不为 "#");最后一个 li 表示当前页,不含 <a>,但其内的标识元素带 aria-current="page"。
3. 一个 <main id="main-content">,内部标题层级:main 内有且仅有一个 <h1>;h1 之后存在 <h2>;若存在 <h3> 则文档顺序上必须出现在某个 h2 之后。
只返回 HTML,用 \`\`\`html 包裹,不要解释。`,
    test: `
const skip = $('a[href="#main-content"]');
if(!skip) throw 'missing skip link a[href=#main-content]';
if(!skip.textContent.trim()) throw 'skip link must have text';
const bc = $('nav[aria-label="面包屑"]');
if(!bc) throw 'missing nav[aria-label=面包屑]';
const ol = bc.querySelector('ol');
if(!ol) throw 'breadcrumb must use ol';
const lis = ol.querySelectorAll(':scope > li');
if(lis.length!==3) throw 'breadcrumb must have exactly 3 li, got '+lis.length;
for(let i=0;i<2;i++){
  const a = lis[i].querySelector('a[href]');
  if(!a) throw 'breadcrumb li '+i+' must contain a[href]';
  const h = a.getAttribute('href');
  if(!h || h==='#') throw 'breadcrumb li '+i+' href must be non-empty and not #';
}
const last = lis[2];
if(last.querySelector('a')) throw 'last breadcrumb li must not contain a';
const cur = last.querySelector('[aria-current="page"]');
if(!cur) throw 'last breadcrumb li must contain element with aria-current=page';
const main = $('main#main-content');
if(!main) throw 'missing main#main-content';
const h1s = main.querySelectorAll('h1');
if(h1s.length!==1) throw 'main must contain exactly one h1, got '+h1s.length;
const h2 = main.querySelector('h2');
if(!h2) throw 'main must contain an h2';
if(!(h1s[0].compareDocumentPosition(h2) & 4)) throw 'h1 must precede h2';
const h3s = main.querySelectorAll('h3');
if(h3s.length){
  h3s.forEach((h3,i)=>{
    if(!(h2.compareDocumentPosition(h3) & 4)) throw 'h3 '+i+' must follow an h2';
  });
}
`,
    canonical: `<a href="#main-content">跳到主内容</a>
<nav aria-label="面包屑">
  <ol>
    <li><a href="/">首页</a></li>
    <li><a href="/docs">文档</a></li>
    <li><span aria-current="page">安装指南</span></li>
  </ol>
</nav>
<main id="main-content">
  <h1>安装指南</h1>
  <h2>系统要求</h2>
  <p>需要 Node 20+。</p>
  <h3>可选依赖</h3>
  <p>其余内容。</p>
</main>`
  }
];
