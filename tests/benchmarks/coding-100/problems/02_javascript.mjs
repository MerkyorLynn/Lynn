export default [
  {
    id: 'js-01-signal',
    lang: 'javascript',
    prompt: `JS(Node 20, CommonJS):手写一个类 Vue/Solid 的响应式系统,导出工厂函数 createReactive(),其返回 { signal, computed, effect }。

要求:
- signal(initial) 返回 [get, set] 元组。调用 get() 读取当前值;set(next) 写入新值。
- effect(fn) 立即执行一次 fn,并自动追踪 fn 执行期间读取过的所有 signal/computed 作为依赖;当任一依赖变化时自动重新执行 fn(每次重跑前需清理旧依赖,避免分支切换造成的过期依赖)。
- computed(fn) 返回一个 getter,惰性求值并缓存;其依赖变化时自动重新计算,且若计算结果改变需通知下游 effect/computed。
- 依赖收集需支持嵌套 effect(用栈维护当前活动 effect)。
- 使用 Object.is 判断相等:set 同值不触发;computed 结果同值不向下游传播。

module.exports = { createReactive }。只返回代码,用 \`\`\`js 包裹,module.exports 导出,不要解释。`,
    test: `
const { signal, computed, effect } = createReactive();
const [count,setCount]=signal(1);
const double=computed(()=>count()*2);
let log=[];
effect(()=>{ log.push(double()); });
if(log[log.length-1]!==2) throw 'init computed';
setCount(5);
if(double()!==10) throw 'computed update';
if(log[log.length-1]!==10) throw 'effect not rerun on computed change';
const lenBefore=log.length;
setCount(5);
if(log.length!==lenBefore) throw 'noop set retriggered';
const [a,setA]=signal(10);
const [b,setB]=signal(20);
const sum=computed(()=>a()+b());
let runs=0;
effect(()=>{ sum(); runs++; });
if(runs!==1) throw 'sum effect init';
setA(100);
if(sum()!==120) throw 'sum value';
if(runs!==2) throw 'sum effect rerun';
setB(0);
if(sum()!==100) throw 'sum value 2';
if(runs!==3) throw 'sum effect rerun 2';
`,
    canonical: `
function createReactive(){
  let active=null;
  const stack=[];
  function track(dep){ if(active){ dep.add(active); active.deps.push(dep); } }
  function trigger(dep){ for(const e of Array.from(dep)){ if(e!==active) e.run(); } }
  function cleanup(e){ for(const d of e.deps) d.delete(e); e.deps.length=0; }
  function runWith(e, fn){
    cleanup(e); active=e; stack.push(e);
    try{ return fn(); } finally { stack.pop(); active=stack[stack.length-1]||null; }
  }
  function signal(initial){
    let value=initial; const dep=new Set();
    const get=()=>{ track(dep); return value; };
    const set=(nv)=>{ if(Object.is(nv,value)) return; value=nv; trigger(dep); };
    return [get,set];
  }
  function effect(fn){
    const e={ deps:[], run(){ return runWith(e, fn); } };
    e.run(); return e;
  }
  function computed(fn){
    let value; const dep=new Set();
    const e={ deps:[], run(){
      const nv=runWith(e, fn);
      if(!Object.is(nv,value)){ value=nv; trigger(dep); }
    }};
    e.run();
    return ()=>{ track(dep); return value; };
  }
  return { signal, computed, effect };
}
module.exports={createReactive};
`
  },
  {
    id: 'js-02-eventloop',
    lang: 'javascript',
    prompt: `JS(Node 20, CommonJS):实现一个确定性的事件循环模拟器 class EventLoop(不依赖真实定时器)。

接口:
- setTimeout(fn, delay=0):注册一个宏任务,在虚拟时间 当前时间+delay 触发。
- queueMicrotask(fn):注册一个微任务。
- run():驱动整个循环直到清空,并按真实浏览器/Node 语义调度。

调度语义(必须严格实现):
- 同步阶段注册的微任务先于任何宏任务执行。
- 每执行完一个宏任务后,必须把当前微任务队列「全部」排干(包括在微任务执行过程中新加入的微任务),然后才执行下一个宏任务。
- 宏任务按触发时间升序执行;相同触发时间按注册先后(FIFO)执行。
- 在宏任务中新加入的微任务,在该宏任务之后、下一个宏任务之前排干。
- 维护虚拟时间:执行某宏任务时,时间推进到该任务的触发时间(不回退)。

module.exports = { EventLoop }。只返回代码,用 \`\`\`js 包裹,module.exports 导出,不要解释。`,
    test: `
const loop=new EventLoop();
const order=[];
order.push('sync-start');
loop.setTimeout(()=>{ order.push('timeout-0'); loop.queueMicrotask(()=>order.push('micro-from-timeout')); }, 0);
loop.queueMicrotask(()=>order.push('micro-1'));
loop.setTimeout(()=>order.push('timeout-10'), 10);
loop.queueMicrotask(()=>{ order.push('micro-2'); loop.queueMicrotask(()=>order.push('micro-nested')); });
loop.setTimeout(()=>order.push('timeout-5'), 5);
order.push('sync-end');
loop.run();
const expected=['sync-start','sync-end','micro-1','micro-2','micro-nested','timeout-0','micro-from-timeout','timeout-5','timeout-10'];
if(JSON.stringify(order)!==JSON.stringify(expected)) throw 'order wrong: '+JSON.stringify(order);
`,
    canonical: `
class EventLoop {
  constructor(){ this.macro=[]; this.micro=[]; this.time=0; this._seq=0; }
  setTimeout(fn, delay=0){ this.macro.push({fn, time:this.time+delay, seq:this._seq++}); }
  queueMicrotask(fn){ this.micro.push(fn); }
  _drainMicro(){
    while(this.micro.length){ const fn=this.micro.shift(); fn(); }
  }
  run(){
    this._drainMicro();
    while(this.macro.length){
      this.macro.sort((a,b)=> a.time-b.time || a.seq-b.seq);
      const job=this.macro.shift();
      this.time=Math.max(this.time, job.time);
      job.fn();
      this._drainMicro();
    }
  }
}
module.exports={EventLoop};
`
  },
  {
    id: 'js-03-deepclone',
    lang: 'javascript',
    prompt: `JS(Node 20, CommonJS):手写 deepClone(value) 深克隆,导出 deepClone。

要求:
- 正确克隆:原始值(含 undefined)、普通对象、数组、Date、RegExp(保留 source 与 flags)、Map、Set。
- 处理循环引用(对象引用自身、数组包含自身等),不得栈溢出。
- 保留共享引用的同一性:若原对象中两个字段指向同一对象,克隆后这两个字段仍指向「同一个」克隆对象(而非两份拷贝)。
- 保留对象原型链(用 Object.getPrototypeOf / Object.create)。
- 用 Reflect.ownKeys 遍历自有键(含 symbol 键),并对 getter/setter 访问器属性用 Object.defineProperty 原样拷贝描述符(不触发取值)。
- 克隆出的 Date/RegExp/Map/Set/对象/数组都必须是「新实例」,不能与源共享。

可用 WeakMap 记录 已克隆映射 以处理循环与共享引用。module.exports = { deepClone }。只返回代码,用 \`\`\`js 包裹,module.exports 导出,不要解释。`,
    test: `
const shared={tag:'shared'};
const orig={
  num:1, str:'a', nul:null, undef:undefined, bool:true,
  date:new Date(1700000000000),
  re:/ab+c/gi,
  arr:[1,2,{nested:true}],
  map:new Map([['k1',1],['k2',{deep:2}]]),
  set:new Set([1,2,3]),
  s1:shared, s2:shared
};
orig.self=orig;
orig.arr.push(orig);
const c=deepClone(orig);
if(c===orig) throw 'same ref';
if(c.num!==1||c.str!=='a'||c.nul!==null||c.bool!==true) throw 'prims';
if(!('undef' in c)||c.undef!==undefined) throw 'undef key lost';
if(!(c.date instanceof Date)||c.date.getTime()!==1700000000000) throw 'date';
if(c.date===orig.date) throw 'date ref';
if(!(c.re instanceof RegExp)||c.re.source!=='ab+c'||c.re.flags!=='gi') throw 're';
if(c.arr[2].nested!==true) throw 'arr nested';
if(c.arr[2]===orig.arr[2]) throw 'arr nested ref';
if(!(c.map instanceof Map)||c.map.get('k1')!==1||c.map.get('k2').deep!==2) throw 'map';
if(c.map.get('k2')===orig.map.get('k2')) throw 'map val ref';
if(!(c.set instanceof Set)||![...c.set].every((v,i)=>v===[1,2,3][i])) throw 'set';
if(c.self!==c) throw 'circular self not preserved';
if(c.arr[3]!==c) throw 'circular in array not preserved';
if(c.s1!==c.s2) throw 'shared ref identity lost';
if(c.s1===shared) throw 'shared not cloned';
`,
    canonical: `
function deepClone(value, seen=new WeakMap()){
  if(value===null || typeof value!=='object') return value;
  if(seen.has(value)) return seen.get(value);
  if(value instanceof Date) return new Date(value.getTime());
  if(value instanceof RegExp) return new RegExp(value.source, value.flags);
  if(Array.isArray(value)){
    const arr=[]; seen.set(value,arr);
    for(let i=0;i<value.length;i++) arr[i]=deepClone(value[i],seen);
    return arr;
  }
  if(value instanceof Map){
    const m=new Map(); seen.set(value,m);
    for(const [k,v] of value) m.set(deepClone(k,seen), deepClone(v,seen));
    return m;
  }
  if(value instanceof Set){
    const s=new Set(); seen.set(value,s);
    for(const v of value) s.add(deepClone(v,seen));
    return s;
  }
  const out=Object.create(Object.getPrototypeOf(value));
  seen.set(value,out);
  for(const key of Reflect.ownKeys(value)){
    const desc=Object.getOwnPropertyDescriptor(value,key);
    if(desc.get||desc.set){ Object.defineProperty(out,key,desc); }
    else { out[key]=deepClone(desc.value,seen); }
  }
  return out;
}
module.exports={deepClone};
`
  },
  {
    id: 'js-04-maplimit',
    lang: 'javascript',
    prompt: `JS(Node 20, CommonJS):实现带并发上限的异步映射 async function mapLimit(items, limit, asyncFn),导出 mapLimit。

要求:
- 对 items 中每个元素调用 asyncFn(item, index)(返回 Promise),收集结果。
- 返回 Promise,解析为与「输入顺序一致」的结果数组(即使后面的元素先完成,结果也要按原下标放置)。
- 任意时刻在飞行中的 asyncFn 调用数不得超过 limit;在有剩余任务时应尽量保持并发饱和到 limit。
- limit 大于 items 长度时,实际并发为 items 长度;空数组返回空数组。
- 用 工作协程池 模式:启动 min(limit, items.length) 个 worker,每个 worker 循环领取下一个未处理下标直到取完。

module.exports = { mapLimit }。只返回代码,用 \`\`\`js 包裹,module.exports 导出,不要解释。`,
    test: `
(async()=>{
  let inFlight=0, peak=0;
  const items=[10,20,30,40,50,60,70];
  const asyncFn=async(x,i)=>{
    inFlight++; peak=Math.max(peak,inFlight);
    await new Promise(res=>setImmediate(res));
    await new Promise(res=>setImmediate(res));
    inFlight--;
    return x*2;
  };
  const out=await mapLimit(items, 3, asyncFn);
  if(JSON.stringify(out)!==JSON.stringify([20,40,60,80,100,120,140])) throw 'results: '+JSON.stringify(out);
  if(peak>3) throw 'exceeded limit, peak='+peak;
  if(peak!==3) throw 'did not reach limit, peak='+peak;
  let peak2=0, f2=0;
  const out2=await mapLimit([1,2], 10, async(x)=>{ f2++; peak2=Math.max(peak2,f2); await new Promise(r=>setImmediate(r)); f2--; return x+1; });
  if(JSON.stringify(out2)!==JSON.stringify([2,3])) throw 'small results';
  if(peak2!==2) throw 'small peak '+peak2;
  const out3=await mapLimit([], 3, async()=>1);
  if(JSON.stringify(out3)!=='[]') throw 'empty';
  const out4=await mapLimit([0,1,2], 1, async(x)=>{ return x*10; });
  if(JSON.stringify(out4)!==JSON.stringify([0,10,20])) throw 'seq order';
})().then(()=>{}).catch(e=>{ throw e; });
`,
    canonical: `
async function mapLimit(items, limit, asyncFn){
  const results=new Array(items.length);
  let nextIndex=0;
  async function worker(){
    while(true){
      const i=nextIndex++;
      if(i>=items.length) return;
      results[i]=await asyncFn(items[i], i);
    }
  }
  const n=Math.max(1, Math.min(limit, items.length));
  const workers=[];
  for(let k=0;k<n;k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
module.exports={mapLimit};
`
  },
  {
    id: 'js-05-debounce-throttle',
    lang: 'javascript',
    prompt: `JS(Node 20, CommonJS):用「可注入时钟」实现确定性的防抖与节流(不依赖真实 setTimeout 延迟)。导出 { makeTimer, debounce, throttle }。

makeTimer():返回一个虚拟时钟对象,含:
- now():返回当前虚拟时间(起始为 0)。
- schedule(fn, delay):在 当前时间+delay 安排回调,返回 id。
- cancel(id):取消尚未触发的回调。
- advance(ms):把虚拟时间向前推进 ms,期间所有到点(at <= 目标时间)的回调按时间升序、同一时刻按注册先后依次触发(回调内新安排的、落在窗口内的任务也要触发);推进结束后 now() 等于目标时间。

debounce(fn, wait, timer):返回防抖函数。leading=false,trailing=true:每次调用重置计时,仅在最后一次调用后静默 wait 时间触发一次,使用「最后一次」的参数;并提供 .cancel() 取消挂起触发。

throttle(fn, wait, timer):返回节流函数。leading=true,trailing=true:首次调用立即触发(leading);窗口内的后续调用不立即触发,但会安排一个 trailing 调用在窗口末尾用「最近一次」的参数触发;静默超过 wait 后的下一次调用又作为 leading 立即触发。

时间相关一律走传入的 timer(now/schedule/cancel),禁止用真实定时器。module.exports = { makeTimer, debounce, throttle }。只返回代码,用 \`\`\`js 包裹,module.exports 导出,不要解释。`,
    test: `
const t1=makeTimer();
let dcalls=[];
const d=debounce((x)=>dcalls.push(x), 100, t1);
d(1); d(2); d(3);
t1.advance(50);
if(dcalls.length!==0) throw 'debounce fired early';
t1.advance(50);
if(JSON.stringify(dcalls)!==JSON.stringify([3])) throw 'debounce trailing: '+JSON.stringify(dcalls);
d(4);
t1.advance(99);
if(dcalls.length!==1) throw 'debounce early 2';
t1.advance(1);
if(JSON.stringify(dcalls)!==JSON.stringify([3,4])) throw 'debounce 2: '+JSON.stringify(dcalls);

const t2=makeTimer();
let tcalls=[];
const th=throttle((x)=>tcalls.push([x, t2.now()]), 100, t2);
th('a');
if(JSON.stringify(tcalls)!==JSON.stringify([['a',0]])) throw 'throttle leading: '+JSON.stringify(tcalls);
t2.advance(30); th('b');
t2.advance(30); th('c');
if(tcalls.length!==1) throw 'throttle mid';
t2.advance(40);
if(JSON.stringify(tcalls)!==JSON.stringify([['a',0],['c',100]])) throw 'throttle trailing: '+JSON.stringify(tcalls);
t2.advance(200); th('d');
if(JSON.stringify(tcalls[tcalls.length-1])!==JSON.stringify(['d',300])) throw 'throttle leading 2: '+JSON.stringify(tcalls);
`,
    canonical: `
function makeTimer(){
  let t=0; let seq=0; const jobs=new Map();
  return {
    now(){ return t; },
    schedule(fn, delay){ const id=++seq; jobs.set(id,{fn, at:t+delay}); return id; },
    cancel(id){ jobs.delete(id); },
    advance(ms){
      const target=t+ms;
      while(true){
        let next=null;
        for(const [id,j] of jobs){ if(j.at<=target && (next===null || j.at<next.at || (j.at===next.at && id<next.id))) next={id, at:j.at, fn:j.fn}; }
        if(!next) break;
        t=next.at; jobs.delete(next.id); next.fn();
      }
      t=target;
    }
  };
}
function debounce(fn, wait, timer){
  let id=null, lastArgs=null;
  function debounced(...args){
    lastArgs=args;
    if(id!==null) timer.cancel(id);
    id=timer.schedule(()=>{ id=null; fn.apply(this, lastArgs); }, wait);
  }
  debounced.cancel=()=>{ if(id!==null){ timer.cancel(id); id=null; } };
  return debounced;
}
function throttle(fn, wait, timer){
  let last=-Infinity, id=null, lastArgs=null;
  function invoke(){ last=timer.now(); id=null; fn.apply(null, lastArgs); }
  function throttled(...args){
    lastArgs=args;
    const remaining=wait-(timer.now()-last);
    if(remaining<=0){
      if(id!==null){ timer.cancel(id); id=null; }
      invoke();
    } else if(id===null){
      id=timer.schedule(invoke, remaining);
    }
  }
  return throttled;
}
module.exports={makeTimer, debounce, throttle};
`
  },
  {
    id: 'js-06-vdom-diff',
    lang: 'javascript',
    prompt: `JS(Node 20, CommonJS):实现虚拟 DOM 的 diff(oldV, newV) 生成补丁列表,导出 diff。

vnode 结构:{ tag, props:{...}, children:[vnode|string|number] };文本节点用 字符串或数字 表示。
diff 返回补丁数组,补丁形状如下,path 为从根出发的「子节点下标数组」,根的 path 为 []:
- { type:'REPLACE', path, node }  整体替换(新增子节点也用 REPLACE,path 指向新下标)
- { type:'REMOVE', path }         删除节点
- { type:'PROPS', path, set, remove }  set 为需新增/改变的属性对象,remove 为需删除的属性名数组
- { type:'TEXT', path, text }     文本节点内容变化,text 为新字符串

规则:
- 文本对文本:内容(按字符串比较)不同则发 TEXT;一方是文本一方是元素则 REPLACE。
- tag 不同则 REPLACE(不再递归)。
- 同 tag:先比较 props 生成 PROPS(set 为新值不同或新增的键;remove 为旧有而新无的键;无变化则不发 PROPS),再按下标递归比较 children。
- newV 为 undefined(旧有新无的子节点)发 REMOVE。
- 第三个参数 path 默认 []。

属性按引用/全等(!==)比较是否变化。module.exports = { diff }。只返回代码,用 \`\`\`js 包裹,module.exports 导出,不要解释。`,
    test: `
const h=(tag,props,...children)=>({tag,props:props||{},children});
if(diff(h('div',{id:'a'},'x'), h('div',{id:'a'},'x')).length!==0) throw 'identical';
let p=diff(h('div',{},'hello'), h('div',{},'world'));
if(p.length!==1||p[0].type!=='TEXT'||p[0].text!=='world'||JSON.stringify(p[0].path)!=='[0]') throw 'text: '+JSON.stringify(p);
p=diff(h('div',{a:1,b:2},'x'), h('div',{a:9,c:3},'x'));
const pp=p.find(x=>x.type==='PROPS');
if(!pp) throw 'no props patch';
if(JSON.stringify(pp.set)!==JSON.stringify({a:9,c:3})) throw 'props set: '+JSON.stringify(pp.set);
if(JSON.stringify(pp.remove.sort())!==JSON.stringify(['b'])) throw 'props remove: '+JSON.stringify(pp.remove);
if(JSON.stringify(pp.path)!=='[]') throw 'props path';
p=diff(h('div',{},'x'), h('span',{},'x'));
if(p.length!==1||p[0].type!=='REPLACE'||p[0].node.tag!=='span') throw 'replace tag';
p=diff(h('ul',{}, h('li',{},'a'), h('li',{},'b')), h('ul',{}, h('li',{},'a')));
const rem=p.find(x=>x.type==='REMOVE');
if(!rem||JSON.stringify(rem.path)!=='[1]') throw 'remove child: '+JSON.stringify(p);
p=diff(h('ul',{}, h('li',{},'a')), h('ul',{}, h('li',{},'a'), h('li',{},'b')));
const add=p.find(x=>x.type==='REPLACE'&&JSON.stringify(x.path)==='[1]');
if(!add||add.node.tag!=='li') throw 'add child: '+JSON.stringify(p);
p=diff(
  h('div',{}, h('section',{}, h('p',{class:'x'},'old'))),
  h('div',{}, h('section',{}, h('p',{class:'y'},'new')))
);
const tp=p.find(x=>x.type==='TEXT');
if(!tp||JSON.stringify(tp.path)!=='[0,0,0]'||tp.text!=='new') throw 'nested text: '+JSON.stringify(p);
const np=p.find(x=>x.type==='PROPS');
if(!np||JSON.stringify(np.path)!=='[0,0]'||np.set.class!=='y') throw 'nested props: '+JSON.stringify(p);
`,
    canonical: `
function isText(n){ return typeof n==='string' || typeof n==='number'; }
function diff(oldV, newV, path=[], patches=[]){
  if(newV===undefined){ patches.push({type:'REMOVE', path}); return patches; }
  if(isText(oldV) || isText(newV)){
    if(isText(oldV) && isText(newV)){
      if(String(oldV)!==String(newV)) patches.push({type:'TEXT', path, text:String(newV)});
    } else {
      patches.push({type:'REPLACE', path, node:newV});
    }
    return patches;
  }
  if(oldV.tag!==newV.tag){
    patches.push({type:'REPLACE', path, node:newV});
    return patches;
  }
  const set={}, remove=[];
  const oldProps=oldV.props||{}, newProps=newV.props||{};
  for(const k of Object.keys(newProps)){
    if(oldProps[k]!==newProps[k]) set[k]=newProps[k];
  }
  for(const k of Object.keys(oldProps)){
    if(!(k in newProps)) remove.push(k);
  }
  if(Object.keys(set).length || remove.length){
    patches.push({type:'PROPS', path, set, remove});
  }
  const oldC=oldV.children||[], newC=newV.children||[];
  const max=Math.max(oldC.length, newC.length);
  for(let i=0;i<max;i++){
    if(i>=oldC.length){
      patches.push({type:'REPLACE', path:[...path,i], node:newC[i]});
    } else {
      diff(oldC[i], newC[i], [...path,i], patches);
    }
  }
  return patches;
}
module.exports={diff};
`
  },
  {
    id: 'js-07-json-parser',
    lang: 'javascript',
    prompt: `JS(Node 20, CommonJS):手写 JSON 解析器 parseJSON(str)(禁止使用 JSON.parse),导出 parseJSON。

需支持完整 JSON 文法:对象、数组、嵌套;字符串(含转义 \\\\" \\\\\\\\ \\\\/ \\\\b \\\\f \\\\n \\\\r \\\\t 与 \\\\uXXXX);数字(整数/负号/小数/指数,遵循 JSON 数字文法,如前导零仅允许单个 0);字面量 true/false/null;值与结构符号周围允许空白。

非法输入必须抛出错误(throw):未闭合结构、字符串未终止、缺冒号、尾随逗号、非法数字(如 01、1.、--1)、未加引号的键、顶层多余内容、空串等。

module.exports = { parseJSON }。只返回代码,用 \`\`\`js 包裹,module.exports 导出,不要解释。`,
    test: `
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
if(parseJSON('  42 ')!==42) throw 'int';
if(parseJSON('-3.14')!==-3.14) throw 'neg float';
if(parseJSON('1.5e3')!==1500) throw 'exp';
if(parseJSON('-0')!==0) throw 'neg zero';
if(parseJSON('true')!==true) throw 'true';
if(parseJSON('false')!==false) throw 'false';
if(parseJSON('null')!==null) throw 'null';
if(parseJSON('"hello"')!=='hello') throw 'str';
if(parseJSON('"a\\\\nb"')!=='a\\nb') throw 'escape n';
if(parseJSON('"tab\\\\tend"')!=='tab\\tend') throw 'escape t';
if(parseJSON('"quote:\\\\""')!=='quote:"') throw 'escape quote';
if(parseJSON('"slash:\\\\/"')!=='slash:/') throw 'escape slash';
if(parseJSON('"\\\\u0041\\\\u0042"')!=='AB') throw 'unicode';
if(!eq(parseJSON('[1,2,3]'),[1,2,3])) throw 'arr';
if(!eq(parseJSON('[]'),[])) throw 'empty arr';
if(!eq(parseJSON('{}'),{})) throw 'empty obj';
if(!eq(parseJSON('{"a":1,"b":[true,null,{"c":-2.5}]}'),{a:1,b:[true,null,{c:-2.5}]})) throw 'nested';
if(!eq(parseJSON('  {  "x" : [ 1 , 2 ] , "y" : "z" }  '),{x:[1,2],y:'z'})) throw 'whitespace';
const deep=parseJSON('{"users":[{"name":"Ann","age":30},{"name":"Bob","tags":["a","b"]}]}');
if(deep.users[1].tags[1]!=='b') throw 'deep';
const bad=['{','[1,2','"unterminated','{"a":}','01','1.','--1','{a:1}','[1,]','tru','1 2','{"a":1,}',''];
for(const s of bad){
  let threw=false;
  try{ parseJSON(s); }catch(e){ threw=true; }
  if(!threw) throw 'should have thrown for: '+JSON.stringify(s);
}
`,
    canonical: `
function parseJSON(str){
  let i=0;
  const len=str.length;
  function err(msg){ throw new SyntaxError(msg+' at '+i); }
  function ws(){ while(i<len && (str[i]===' '||str[i]==='\\t'||str[i]==='\\n'||str[i]==='\\r')) i++; }
  function value(){
    ws();
    const c=str[i];
    if(c==='{') return obj();
    if(c==='[') return arr();
    if(c==='"') return string();
    if(c==='-'||(c>='0'&&c<='9')) return number();
    if(str.startsWith('true',i)){ i+=4; return true; }
    if(str.startsWith('false',i)){ i+=5; return false; }
    if(str.startsWith('null',i)){ i+=4; return null; }
    err('unexpected token');
  }
  function obj(){
    i++; ws(); const o={};
    if(str[i]==='}'){ i++; return o; }
    while(true){
      ws();
      if(str[i]!=='"') err('expected key string');
      const k=string();
      ws();
      if(str[i]!==':') err('expected colon');
      i++;
      o[k]=value();
      ws();
      if(str[i]===','){ i++; continue; }
      if(str[i]==='}'){ i++; return o; }
      err('expected , or }');
    }
  }
  function arr(){
    i++; ws(); const a=[];
    if(str[i]===']'){ i++; return a; }
    while(true){
      a.push(value());
      ws();
      if(str[i]===','){ i++; continue; }
      if(str[i]===']'){ i++; return a; }
      err('expected , or ]');
    }
  }
  function string(){
    i++; let out='';
    while(i<len){
      const c=str[i++];
      if(c==='"') return out;
      if(c==='\\\\'){
        const e=str[i++];
        if(e==='"') out+='"';
        else if(e==='\\\\') out+='\\\\';
        else if(e==='/') out+='/';
        else if(e==='b') out+='\\b';
        else if(e==='f') out+='\\f';
        else if(e==='n') out+='\\n';
        else if(e==='r') out+='\\r';
        else if(e==='t') out+='\\t';
        else if(e==='u'){
          const hex=str.slice(i,i+4);
          if(!/^[0-9a-fA-F]{4}$/.test(hex)) err('bad unicode');
          out+=String.fromCharCode(parseInt(hex,16)); i+=4;
        } else err('bad escape');
      } else if(c.charCodeAt(0)<0x20){ err('control char in string'); }
      else out+=c;
    }
    err('unterminated string');
  }
  function number(){
    const start=i;
    if(str[i]==='-') i++;
    if(str[i]==='0'){ i++; }
    else if(str[i]>='1'&&str[i]<='9'){ while(str[i]>='0'&&str[i]<='9') i++; }
    else err('invalid number');
    if(str[i]==='.'){ i++; if(!(str[i]>='0'&&str[i]<='9')) err('bad frac'); while(str[i]>='0'&&str[i]<='9') i++; }
    if(str[i]==='e'||str[i]==='E'){ i++; if(str[i]==='+'||str[i]==='-') i++; if(!(str[i]>='0'&&str[i]<='9')) err('bad exp'); while(str[i]>='0'&&str[i]<='9') i++; }
    return Number(str.slice(start,i));
  }
  const result=value();
  ws();
  if(i!==len) err('trailing content');
  return result;
}
module.exports={parseJSON};
`
  },
  {
    id: 'js-08-proxy-observe',
    lang: 'javascript',
    prompt: `JS(Node 20, CommonJS):用 Proxy 实现「深度可观察对象」 observe(target, onChange),返回一个代理。导出 observe。

要求:
- 对 target 及其任意深度的嵌套对象/数组的「set / delete」都触发 onChange 回调。
- 回调参数为 { type, path, value, oldValue }:type 为 'set' 或 'delete';path 为从根到该键的「键名数组」;set 时带 value;两种情况都带 oldValue(新增键时 oldValue 为 undefined)。
- 嵌套对象需惰性递归代理(在 get 时按需包裹),且「新赋值」进去的嵌套对象/数组之后被改动时也要能被观察到。
- 数组操作也要可观察(例如对某下标赋值;push 会触发 对应下标的 set);path 中的下标用字符串键名(如 '0'、'2')。
- 用 Object.is 判断:对已存在的键赋同值不触发回调;symbol 键的读写直接透传 Reflect 不上报。

用 Reflect 完成底层读写。module.exports = { observe }。只返回代码,用 \`\`\`js 包裹,module.exports 导出,不要解释。`,
    test: `
let events=[];
const state=observe({ user:{ name:'a', addr:{ city:'x' } }, list:[1,2] }, e=>events.push(e));
state.user.name='b';
const e0=events[events.length-1];
if(e0.type!=='set'||JSON.stringify(e0.path)!==JSON.stringify(['user','name'])||e0.value!=='b'||e0.oldValue!=='a') throw 'top set: '+JSON.stringify(e0);
state.user.addr.city='y';
const e1=events[events.length-1];
if(JSON.stringify(e1.path)!==JSON.stringify(['user','addr','city'])||e1.value!=='y'||e1.oldValue!=='x') throw 'deep set: '+JSON.stringify(e1);
events=[];
state.list[0]=99;
const e2=events.find(e=>JSON.stringify(e.path)===JSON.stringify(['list','0']));
if(!e2||e2.value!==99||e2.oldValue!==1) throw 'array set: '+JSON.stringify(events);
events=[];
state.list.push(3);
const idxSet=events.find(e=>e.type==='set'&&e.path[0]==='list'&&e.path[1]==='2');
if(!idxSet||idxSet.value!==3) throw 'push idx: '+JSON.stringify(events);
events=[];
state.user.addr={ city:'z', zip:'000' };
state.user.addr.zip='111';
const nested=events.find(e=>JSON.stringify(e.path)===JSON.stringify(['user','addr','zip'])&&e.value==='111');
if(!nested) throw 'newly assigned object not observed: '+JSON.stringify(events);
events=[];
delete state.user.name;
const del=events[events.length-1];
if(del.type!=='delete'||JSON.stringify(del.path)!==JSON.stringify(['user','name'])||del.oldValue!=='b') throw 'delete: '+JSON.stringify(del);
events=[];
state.user.addr.city='z2';
events=[];
state.user.addr.city='z2';
if(events.length!==0) throw 'noop set fired: '+JSON.stringify(events);
`,
    canonical: `
function observe(target, onChange){
  function wrap(obj, path){
    if(obj===null || typeof obj!=='object') return obj;
    return new Proxy(obj, {
      get(t, key, recv){
        if(typeof key==='symbol') return Reflect.get(t,key,recv);
        const v=Reflect.get(t,key,recv);
        if(v!==null && typeof v==='object' && !(typeof key==='string' && key==='constructor')){
          return wrap(v, [...path, key]);
        }
        return v;
      },
      set(t, key, value, recv){
        if(typeof key==='symbol') return Reflect.set(t,key,value,recv);
        const had=Object.prototype.hasOwnProperty.call(t,key);
        const oldValue=t[key];
        const result=Reflect.set(t, key, value, recv);
        if(!had || !Object.is(oldValue, value)){
          onChange({ type:'set', path:[...path, key], value, oldValue: had?oldValue:undefined });
        }
        return result;
      },
      deleteProperty(t, key){
        if(typeof key==='symbol') return Reflect.deleteProperty(t,key);
        const had=Object.prototype.hasOwnProperty.call(t,key);
        const oldValue=t[key];
        const result=Reflect.deleteProperty(t, key);
        if(had) onChange({ type:'delete', path:[...path, key], oldValue });
        return result;
      }
    });
  }
  return wrap(target, []);
}
module.exports={observe};
`
  },
  {
    id: 'js-09-lazy-iter',
    lang: 'javascript',
    prompt: `JS(Node 20, CommonJS):实现惰性迭代器管道 Lazy(source),source 为任意可迭代对象(含无限生成器)。导出 Lazy。

Lazy 返回的对象本身可迭代([Symbol.iterator]),并支持链式中间操作(均为惰性,返回新的 Lazy):map(fn) [fn(x,index)]、filter(fn)、flatMap(fn)[返回可迭代,展开一层]、take(n)[n<=0 取空]、takeWhile(fn)[fn(x,index) 为假即停]。

终端操作:toArray();reduce(fn, init?)[带或不带初始值;不带且空集合抛 TypeError]。

关键:必须真正惰性,绝不可一次性物化或过度消费 source。对无限生成器配合 take/takeWhile 必须能终止,且只从 source 拉取「恰好需要」的元素数量。

module.exports = { Lazy }。只返回代码,用 \`\`\`js 包裹,module.exports 导出,不要解释。`,
    test: `
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
if(!eq(Lazy([1,2,3,4]).map(x=>x*2).filter(x=>x>4).toArray(),[6,8])) throw 'map/filter';
if(!eq(Lazy(['a','b','c']).map((x,i)=>x+i).toArray(),['a0','b1','c2'])) throw 'map index';
if(!eq(Lazy([1,2,3]).flatMap(x=>[x,x*10]).toArray(),[1,10,2,20,3,30])) throw 'flatMap';
if(Lazy([1,2,3,4]).reduce((a,b)=>a+b,0)!==10) throw 'reduce';
if(Lazy([5,6,7]).reduce((a,b)=>a+b)!==18) throw 'reduce no init';
function* nats(){ let n=0; while(true) yield n++; }
if(!eq(Lazy(nats()).map(x=>x*x).take(5).toArray(),[0,1,4,9,16])) throw 'infinite take';
if(!eq(Lazy([1,2,3,10,4,5]).takeWhile(x=>x<5).toArray(),[1,2,3])) throw 'takeWhile';
let consumed=0;
function* counted(){ while(true){ consumed++; yield consumed; } }
const out=Lazy(counted()).map(x=>x+100).take(3).toArray();
if(!eq(out,[101,102,103])) throw 'counted out: '+JSON.stringify(out);
if(consumed!==3) throw 'over-consumed: '+consumed;
const L=Lazy([1,2,3]).map(x=>x+1);
if(!eq(L.toArray(),[2,3,4])) throw 'consume once';
let seen=[];
const r=Lazy(nats()).map(x=>{ seen.push(x); return x; }).filter(x=>x%2===0).take(3).toArray();
if(!eq(r,[0,2,4])) throw 'chain: '+JSON.stringify(r);
if(seen[seen.length-1]!==4) throw 'chain over-consume, last seen='+seen[seen.length-1];
`,
    canonical: `
function Lazy(source){
  function* iter(){ yield* source; }
  const api={
    [Symbol.iterator](){ return iter(); },
    map(fn){
      const src=this;
      return Lazy((function*(){ let i=0; for(const x of src) yield fn(x, i++); })());
    },
    filter(fn){
      const src=this;
      return Lazy((function*(){ let i=0; for(const x of src) if(fn(x, i++)) yield x; })());
    },
    flatMap(fn){
      const src=this;
      return Lazy((function*(){ let i=0; for(const x of src){ yield* fn(x, i++); } })());
    },
    take(n){
      const src=this;
      return Lazy((function*(){ if(n<=0) return; let c=0; for(const x of src){ yield x; if(++c>=n) return; } })());
    },
    takeWhile(fn){
      const src=this;
      return Lazy((function*(){ let i=0; for(const x of src){ if(!fn(x,i++)) return; yield x; } })());
    },
    toArray(){ return [...this]; },
    reduce(fn, init){
      let acc=init, started=arguments.length>=2, i=0;
      for(const x of this){
        if(!started){ acc=x; started=true; i++; continue; }
        acc=fn(acc, x, i++);
      }
      if(!started) throw new TypeError('Reduce of empty with no initial value');
      return acc;
    }
  };
  return api;
}
module.exports={Lazy};
`
  },
  {
    id: 'js-10-querystring',
    lang: 'javascript',
    prompt: `JS(Node 20, CommonJS):实现 qs 风格的嵌套查询串解析与序列化,导出 { parseQS, stringifyQS }。

parseQS(str):解析 a=1&b=2;允许可选前导 ?;空串返回 {}。支持方括号嵌套 a[b]=1 -> {a:{b:'1'}};数组 a[]=1&a[]=2 -> {a:['1','2']};混合。键值都 decodeURIComponent 且 + 解码为空格。没有 = 的项值为空串。所有叶子值是字符串。

stringifyQS(obj):对象键按字典序排序;嵌套对象用 a[b]=,数组用 a[]=;结构性方括号保持字面,键名内容与值用 encodeURIComponent。要求 parseQS(stringifyQS(o)) 往返还原(值均字符串)。

module.exports = { parseQS, stringifyQS }。只返回代码,用 \`\`\`js 包裹,module.exports 导出,不要解释。`,
    test: `
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
if(!eq(parseQS('a=1&b=2'),{a:'1',b:'2'})) throw 'flat';
if(!eq(parseQS('?a=1'),{a:'1'})) throw 'leading q';
if(!eq(parseQS(''),{})) throw 'empty';
if(!eq(parseQS('a[b]=1&a[c]=2'),{a:{b:'1',c:'2'}})) throw 'nested obj';
if(!eq(parseQS('a[b][c]=x'),{a:{b:{c:'x'}}})) throw 'deep';
if(!eq(parseQS('a[]=1&a[]=2&a[]=3'),{a:['1','2','3']})) throw 'array';
if(!eq(parseQS('a[b]=1&a[c][]=2&a[c][]=3&d=x'),{a:{b:'1',c:['2','3']},d:'x'})) throw 'mixed: '+JSON.stringify(parseQS('a[b]=1&a[c][]=2&a[c][]=3&d=x'));
if(!eq(parseQS('na%20me=jo%20hn'),{'na me':'jo hn'})) throw 'encoded';
if(!eq(parseQS('q=a%26b'),{q:'a&b'})) throw 'encoded val';
if(!eq(parseQS('q=a+b'),{q:'a b'})) throw 'plus space';
if(!eq(parseQS('flag'),{flag:''})) throw 'no eq';
if(stringifyQS({b:'2',a:'1'})!=='a=1&b=2') throw 'stringify sort: '+stringifyQS({b:'2',a:'1'});
if(stringifyQS({a:{c:'2',b:'1'}})!=='a[b]=1&a[c]=2') throw 'stringify nested: '+stringifyQS({a:{c:'2',b:'1'}});
if(stringifyQS({a:['1','2']})!=='a[]=1&a[]=2') throw 'stringify array: '+stringifyQS({a:['1','2']});
if(stringifyQS({q:'a&b c'})!=='q=a%26b%20c') throw 'stringify encode: '+stringifyQS({q:'a&b c'});
function deepEq(a,b){
  if(a===b) return true;
  if(typeof a!=='object'||typeof b!=='object'||a===null||b===null) return false;
  const ka=Object.keys(a), kb=Object.keys(b);
  if(ka.length!==kb.length) return false;
  for(const k of ka){ if(!Object.prototype.hasOwnProperty.call(b,k)) return false; if(!deepEq(a[k],b[k])) return false; }
  return true;
}
const o={ user:{ name:'a b', tags:['x','y'] }, page:'2', q:'a&b' };
const s=stringifyQS(o);
const back=parseQS(s);
if(!deepEq(back, o)) throw 'roundtrip: '+s+' -> '+JSON.stringify(back);
`,
    canonical: `
function parseQS(str){
  const result={};
  if(str==='' || str==null) return result;
  if(str[0]==='?') str=str.slice(1);
  if(str==='') return result;
  for(const pair of str.split('&')){
    if(pair==='') continue;
    const eq=pair.indexOf('=');
    let rawKey, rawVal;
    if(eq===-1){ rawKey=pair; rawVal=''; }
    else { rawKey=pair.slice(0,eq); rawVal=pair.slice(eq+1); }
    const value=decodeURIComponent(rawVal.replace(/\\+/g,' '));
    const m=rawKey.match(/^([^\\[\\]]*)/);
    let base=decodeURIComponent((m?m[1]:'').replace(/\\+/g,' '));
    const path=[base];
    const re=/\\[([^\\[\\]]*)\\]/g;
    let mm;
    while((mm=re.exec(rawKey))!==null){
      path.push(decodeURIComponent(mm[1].replace(/\\+/g,' ')));
    }
    assign(result, path, value);
  }
  return result;
}
function assign(obj, path, value){
  let cur=obj;
  for(let i=0;i<path.length;i++){
    const key=path[i];
    const last=i===path.length-1;
    const nextKey=path[i+1];
    if(last){
      if(key===''){
        if(!Array.isArray(cur)) throw new Error('array push on non-array');
        cur.push(value);
      } else {
        cur[key]=value;
      }
    } else {
      const childIsArray = nextKey==='';
      if(key===''){
        const child = childIsArray? [] : {};
        cur.push(child);
        cur=child;
      } else {
        if(cur[key]===undefined){ cur[key]= childIsArray? [] : {}; }
        cur=cur[key];
      }
    }
  }
}
function stringifyQS(obj){
  const parts=[];
  function walk(prefix, val){
    if(Array.isArray(val)){
      for(const v of val){ walk(prefix+'[]', v); }
    } else if(val!==null && typeof val==='object'){
      for(const k of Object.keys(val).sort()){
        const childPrefix = prefix===''? encodeURIComponent(k) : prefix+'['+encodeURIComponent(k)+']';
        walk(childPrefix, val[k]);
      }
    } else {
      parts.push(prefix+'='+encodeURIComponent(String(val)));
    }
  }
  walk('', obj);
  return parts.join('&');
}
module.exports={parseQS, stringifyQS};
`
  }
];
