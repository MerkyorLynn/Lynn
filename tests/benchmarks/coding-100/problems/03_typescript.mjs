export default [
  { id: 'ts-01-deep-path-get', lang: 'typescript', prompt: `TS:实现类型安全的深层路径取值。定义 Paths<T>(递归产生所有点号分隔的合法路径,含数组下标如 "tags.0")、ValueAt<T,P>(取该路径对应的精确值类型)、以及函数 getPath<T,P extends Paths<T> & string>(obj,path):ValueAt<T,P>。要求:嵌套对象与数组都支持;路径非法应是类型错误;返回值类型必须精确(字面量保留)。运行时按 "." 切分逐层取值。同时提供辅助类型 Equal<X,Y> 与 Expect<T extends true>(供断言用)。只返回代码(顶层声明,无 import/export),用 \`\`\`ts 包裹,不要解释。`, test: `const data = { user: { name: 'lynn', tags: ['a', 'b'], meta: { age: 30 } } } as const;
const n = getPath(data, 'user.name');
if (n !== 'lynn') throw 'name';
const age = getPath(data, 'user.meta.age');
if (age !== 30) throw 'age';
const tag = getPath(data, 'user.tags.0');
if (tag !== 'a') throw 'tag';
type _t1 = Expect<Equal<typeof n, 'lynn'>>;
const _c1: _t1 = true; if (!_c1) throw 't1';
type _t2 = Expect<Equal<typeof age, 30>>;
const _c2: _t2 = true; if (!_c2) throw 't2';
type _t3 = Expect<Equal<ValueAt<typeof data, 'user.tags.0'>, 'a'>>;
const _c3: _t3 = true; if (!_c3) throw 't3';`, canonical: `type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type Primitive = string | number | boolean | null | undefined | bigint | symbol;

type PathInto<T, Prefix extends string = ''> = T extends Primitive
  ? never
  : T extends readonly (infer E)[]
    ? { [K in keyof T & \`\${number}\`]: \`\${Prefix}\${K}\` | PathInto<E, \`\${Prefix}\${K}.\`> }[keyof T & \`\${number}\`]
    : { [K in keyof T & string]: \`\${Prefix}\${K}\` | PathInto<T[K], \`\${Prefix}\${K}.\`> }[keyof T & string];

type Paths<T> = PathInto<T>;

type ValueAt<T, P extends string> =
  P extends \`\${infer Head}.\${infer Rest}\`
    ? Head extends keyof T
      ? ValueAt<T[Head], Rest>
      : T extends readonly (infer E)[]
        ? ValueAt<E, Rest>
        : never
    : P extends keyof T
      ? T[P]
      : T extends readonly (infer E)[]
        ? E
        : never;

function getPath<T, P extends Paths<T> & string>(obj: T, path: P): ValueAt<T, P> {
  const parts = path.split('.');
  let cur: any = obj;
  for (const part of parts) cur = cur?.[part];
  return cur as ValueAt<T, P>;
}` },
  { id: 'ts-02-typed-state-machine', lang: 'typescript', prompt: `TS:用可辨识联合 + 映射类型实现编译期校验的有限状态机。给定状态转移表类型 StateSchema(状态名 -> { 事件名: 目标状态名 }),实现 class Machine<S extends StateName>,其中 send<E extends EventOf<S>>(event:E) 返回 Machine<NextState<S,E>>(目标状态在类型层精确推导),非法事件必须是类型错误;另有 can(event:string):boolean 运行时判断当前状态是否接受该事件。提供工厂 createMachine():Machine<"idle">。状态:idle/loading/success/failure,转移见 StateSchema。只返回代码(顶层声明,无 import/export),用 \`\`\`ts 包裹,不要解释。`, test: `const m = createMachine();
const loading = m.send('fetch');
if (loading.state !== 'loading') throw 's1';
const fail = loading.send('reject');
if (fail.state !== 'failure') throw 's2';
const back = fail.send('retry');
if (back.state !== 'loading') throw 's3';
if (back.can('resolve') !== true) throw 'c1';
if (back.can('fetch') !== false) throw 'c2';
const done = loading.send('resolve').send('reset');
if (done.state !== 'idle') throw 's4';
const checkType: 'success' = loading.send('resolve').state;
if (checkType !== 'success') throw 's5';`, canonical: `type StateSchema = {
  idle: { fetch: 'loading' };
  loading: { resolve: 'success'; reject: 'failure'; abort: 'idle' };
  success: { reset: 'idle' };
  failure: { retry: 'loading'; reset: 'idle' };
};

type StateName = keyof StateSchema;
type EventOf<S extends StateName> = keyof StateSchema[S] & string;
type NextState<S extends StateName, E extends EventOf<S>> = StateSchema[S][E] extends StateName ? StateSchema[S][E] : never;

class Machine<S extends StateName> {
  constructor(public readonly state: S) {}
  send<E extends EventOf<S>>(event: E): Machine<NextState<S, E>> {
    const table: Record<string, Record<string, string>> = {
      idle: { fetch: 'loading' },
      loading: { resolve: 'success', reject: 'failure', abort: 'idle' },
      success: { reset: 'idle' },
      failure: { retry: 'loading', reset: 'idle' },
    };
    const next = table[this.state as string][event as string] as NextState<S, E>;
    return new Machine(next);
  }
  can(event: string): boolean {
    const table: Record<string, Record<string, string>> = {
      idle: { fetch: 'loading' },
      loading: { resolve: 'success', reject: 'failure', abort: 'idle' },
      success: { reset: 'idle' },
      failure: { retry: 'loading', reset: 'idle' },
    };
    return event in (table[this.state as string] ?? {});
  }
}

function createMachine(): Machine<'idle'> { return new Machine('idle'); }` },
  { id: 'ts-03-typed-pipe', lang: 'typescript', prompt: `TS:实现类型安全的 pipe(...fns)。返回一个函数,入参类型 = 第一个函数的参数,返回类型 = 最后一个函数的返回类型(用递归类型 Last<F> 与 FirstArg<F> 精确推导)。另定义递归类型 PipeOut<F extends Fn[], In>:逐个用 In extends Parameters<F[i]>[0] 校验链路,全程兼容则得到最终返回类型,某一步不兼容则得到 never。运行时依次套用各函数。提供 Equal/Expect 辅助类型。只返回代码(顶层声明,无 import/export),用 \`\`\`ts 包裹,不要解释。`, test: `const f = pipe(
  (x: number) => x + 1,
  (x: number) => x.toString(),
  (x: string) => x.length,
  (x: number) => x > 2
);
const r = f(41);
if (r !== false) throw 'r';
const r2: boolean = f(100);
if (r2 !== true) throw 'r2';
const g = pipe((s: string) => s.toUpperCase(), (s: string) => s + '!');
if (g('hi') !== 'HI!') throw 'g';
const gOut: string = g('x');
if (gOut !== 'X!') throw 'gout';
type Chain = PipeOut<[(s: string) => string, (s: number) => string], string>;
type _t3 = Expect<Equal<Chain, never>>;
const _c3: _t3 = true; if (!_c3) throw 't3';
type Chain2 = PipeOut<[(x: number) => string, (x: string) => number], number>;
type _t4 = Expect<Equal<Chain2, number>>;
const _c4: _t4 = true; if (!_c4) throw 't4';
type L = Last<[(a: number) => string, (b: string) => boolean]>;
type _t5 = Expect<Equal<ReturnType<L>, boolean>>;
const _c5: _t5 = true; if (!_c5) throw 't5';`, canonical: `type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type Fn = (arg: any) => any;

type Last<F extends Fn[]> = F extends [Fn]
  ? F[0]
  : F extends [Fn, ...infer R extends Fn[]]
    ? Last<R>
    : never;

type FirstArg<F extends Fn[]> = F extends [infer H extends Fn, ...Fn[]] ? Parameters<H>[0] : never;

type PipeOut<F extends Fn[], In> =
  F extends [infer H extends Fn, ...infer R extends Fn[]]
    ? In extends Parameters<H>[0]
      ? PipeOut<R, ReturnType<H>>
      : never
    : In;

function pipe<F extends [Fn, ...Fn[]]>(
  ...fns: F
): (input: FirstArg<F>) => ReturnType<Last<F>> {
  return (input: FirstArg<F>) => {
    let acc: any = input;
    for (const fn of fns) acc = fn(acc);
    return acc as ReturnType<Last<F>>;
  };
}` },
  { id: 'ts-04-required-builder', lang: 'typescript', prompt: `TS:实现类型安全的 Builder,只有当全部必填字段都已 set 后才允许 build()。给定 interface Config(host:string;port:number;secure:boolean;retries?:number)。用 RequiredKeys<T> 提取必填键(可选键如 retries 排除)。class ConfigBuilder<Set extends keyof Config = never>:set<K>(key,value:Config[K]) 返回 ConfigBuilder<Set|K>(值类型必须匹配);build() 用 this 参数约束,仅当 RequiredKeys<Config> ⊆ Set 时可调用,否则类型错误。提供工厂 builder()。提供 Equal/Expect。只返回代码(顶层声明,无 import/export),用 \`\`\`ts 包裹,不要解释。`, test: `const cfg = builder()
  .set('host', 'localhost')
  .set('port', 8080)
  .set('secure', true)
  .build();
if (cfg.host !== 'localhost') throw 'h';
if (cfg.port !== 8080) throw 'p';
if (cfg.secure !== true) throw 's';
const cfg2 = builder().set('host', 'h').set('secure', false).set('port', 1).set('retries', 3).build();
if (cfg2.retries !== 3) throw 'r';
type RK = RequiredKeys<Config>;
type _t = Expect<Equal<RK, 'host' | 'port' | 'secure'>>;
const _c: _t = true; if (!_c) throw 't';`, canonical: `type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

interface Config {
  host: string;
  port: number;
  secure: boolean;
  retries?: number;
}

type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];

class ConfigBuilder<Set extends keyof Config = never> {
  private data: Partial<Config> = {};
  set<K extends keyof Config>(key: K, value: Config[K]): ConfigBuilder<Set | K> {
    this.data[key] = value as any;
    return this as unknown as ConfigBuilder<Set | K>;
  }
  build(this: ConfigBuilder<RequiredKeys<Config>> extends ConfigBuilder<infer _> ? ([RequiredKeys<Config>] extends [Set] ? ConfigBuilder<Set> : never) : never): Config {
    return this.data as Config;
  }
}

function builder(): ConfigBuilder { return new ConfigBuilder(); }` },
  { id: 'ts-05-typed-event-emitter', lang: 'typescript', prompt: `TS:实现类型安全的 EventEmitter<Events extends Record<string, any[]>>。on/once/off/emit 都按事件名约束载荷:emit<K>(event:K, ...args:Events[K]),on<K>(event:K, fn:(...args:Events[K])=>void)。监听器参数类型必须精确(错误载荷/未知事件/错误参数个数都应是类型错误)。once 触发一次后自动 off。emit 在无监听器时返回 false,否则调用全部监听器并返回 true。给定事件表 AppEvents(login:[user:string,ts:number];logout:[];error:[err:Error])。提供 Equal/Expect。只返回代码(顶层声明,无 import/export),用 \`\`\`ts 包裹,不要解释。`, test: `const em = new Emitter<AppEvents>();
let captured = '';
let count = 0;
const h = (user: string, ts: number) => { captured = user + ':' + ts; count++; };
em.on('login', h);
em.emit('login', 'lynn', 100);
if (captured !== 'lynn:100') throw 'e1';
if (count !== 1) throw 'e2';
em.off('login', h);
const had = em.emit('login', 'x', 1);
if (had !== false) throw 'e3';
if (count !== 1) throw 'e4';
let onceCount = 0;
em.once('logout', () => { onceCount++; });
em.emit('logout');
em.emit('logout');
if (onceCount !== 1) throw 'e5';
let errMsg = '';
em.on('error', (e) => { errMsg = e.message; });
em.emit('error', new Error('boom'));
if (errMsg !== 'boom') throw 'e6';
type _t = Expect<Equal<AppEvents['login'], [user: string, ts: number]>>;
const _c: _t = true; if (!_c) throw 't';`, canonical: `type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type EventMap = Record<string, any[]>;

class Emitter<Events extends EventMap> {
  private listeners: { [K in keyof Events]?: Array<(...args: Events[K]) => void> } = {};
  on<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void): this {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }
  off<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void): this {
    const arr = this.listeners[event];
    if (arr) this.listeners[event] = arr.filter((f) => f !== fn) as any;
    return this;
  }
  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const arr = this.listeners[event];
    if (!arr || arr.length === 0) return false;
    for (const fn of [...arr]) fn(...args);
    return true;
  }
  once<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void): this {
    const wrapper = (...args: Events[K]) => { this.off(event, wrapper); fn(...args); };
    return this.on(event, wrapper);
  }
}

type AppEvents = {
  login: [user: string, ts: number];
  logout: [];
  error: [err: Error];
};` },
  { id: 'ts-06-route-param-parser', lang: 'typescript', prompt: `TS:实现类型安全的路由匹配。用模板字面量类型 RouteParams<Path> 从形如 "/users/:userId/posts/:postId" 的模式中递归提取参数名,得到 { userId: string; postId: string };无参数时得到 {}。函数 match<Path extends string>(pattern:Path, url:string):RouteParams<Path> | null:按 "/" 分段,段数不等或静态段不匹配返回 null,否则把 :param 段收集为对象返回。访问不存在的参数键应是类型错误。提供 Equal/Expect。只返回代码(顶层声明,无 import/export),用 \`\`\`ts 包裹,不要解释。`, test: `const r = match('/users/:userId/posts/:postId', '/users/42/posts/abc');
if (r === null) throw 'null';
if (r.userId !== '42') throw 'u';
if (r.postId !== 'abc') throw 'p';
const miss = match('/users/:id', '/posts/1');
if (miss !== null) throw 'miss';
const exact = match('/health', '/health');
if (exact === null) throw 'exact';
type P = RouteParams<'/users/:userId/posts/:postId'>;
type _t = Expect<Equal<P, { userId: string; postId: string }>>;
const _c: _t = true; if (!_c) throw 't';
type P2 = RouteParams<'/static/page'>;
type _t2 = Expect<Equal<P2, {}>>;
const _c2: _t2 = true; if (!_c2) throw 't2';
type P3 = RouteParams<'/a/:x'>;
type _t3 = Expect<Equal<P3, { x: string }>>;
const _c3: _t3 = true; if (!_c3) throw 't3';`, canonical: `type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type ParseParams<Path extends string> =
  Path extends \`\${infer _Head}:\${infer Param}/\${infer Rest}\`
    ? { [K in Param]: string } & ParseParams<Rest>
    : Path extends \`\${infer _Head}:\${infer Param}\`
      ? { [K in Param]: string }
      : {};

type RouteParams<Path extends string> = { [K in keyof ParseParams<Path>]: ParseParams<Path>[K] };

function match<Path extends string>(pattern: Path, url: string): RouteParams<Path> | null {
  const pSeg = pattern.split('/').filter(Boolean);
  const uSeg = url.split('/').filter(Boolean);
  if (pSeg.length !== uSeg.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < pSeg.length; i++) {
    const p = pSeg[i];
    if (p.startsWith(':')) out[p.slice(1)] = uSeg[i];
    else if (p !== uSeg[i]) return null;
  }
  return out as RouteParams<Path>;
}` },
  { id: 'ts-07-typed-curry', lang: 'typescript', prompt: `TS:实现类型安全的柯里化 curry。给定 (…args:Args)=>R,返回 Curried<Args,R> = 逐参数的嵌套函数链 (a)=>(b)=>(c)=>R(用递归条件类型推导,每一层参数类型精确)。运行时按原函数的 arity(fn.length)收集参数,集满即调用。例如 curry((a:number,b:number,c:number)=>a+b+c) 得到 (a:number)=>(b:number)=>(c:number)=>number。提供 Equal/Expect。只返回代码(顶层声明,无 import/export),用 \`\`\`ts 包裹,不要解释。`, test: `const add3 = curry((a: number, b: number, c: number): number => a + b + c);
const step1 = add3(1);
const step2 = step1(2);
const result = step2(3);
if (result !== 6) throw 'r1';
if (add3(10)(20)(30) !== 60) throw 'r2';
const join = curry((sep: string, a: string, b: string): string => a + sep + b);
if (join('-')('x')('y') !== 'x-y') throw 'r3';
type Add3T = typeof add3;
type _t = Expect<Equal<Add3T, (a: number) => (b: number) => (c: number) => number>>;
const _c: _t = true; if (!_c) throw 't';
type C = Curried<[string, boolean], number>;
type _t2 = Expect<Equal<C, (arg: string) => (arg: boolean) => number>>;
const _c2: _t2 = true; if (!_c2) throw 't2';
const r2: number = join('|')('a')('b').length;
if (r2 !== 3) throw 't3';`, canonical: `type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type Curried<Args extends any[], R> =
  Args extends []
    ? R
    : Args extends [infer First, ...infer Rest]
      ? (arg: First) => Curried<Rest, R>
      : never;

function curry<Args extends any[], R>(fn: (...args: Args) => R): Curried<Args, R> {
  const arity = fn.length;
  function collect(collected: any[]): any {
    if (collected.length >= arity) return fn(...(collected as Args));
    return (next: any) => collect([...collected, next]);
  }
  return collect([]) as Curried<Args, R>;
}` },
  { id: 'ts-08-deep-flatten-keys', lang: 'typescript', prompt: `TS:实现深层对象扁平化的类型与函数。类型 Flatten<T>:递归把嵌套对象的键用点号连接(如 { b:{ c:string; d:{ e:boolean } } } -> { "b.c":string; "b.d.e":boolean }),原始值与数组作为叶子保留原类型(数组不展开)。注意 boolean 等联合类型不要在条件分支里被分配掉(用 [T] extends [X] 包裹)。函数 flatten(obj) 返回 Flatten<T> 并在运行时正确生成点号键。提供 UnionToIntersection 辅助、Equal/Expect。只返回代码(顶层声明,无 import/export),用 \`\`\`ts 包裹,不要解释。`, test: `const nested = { a: 1, b: { c: 'hi', d: { e: true } }, f: [1, 2] };
const flat = flatten(nested);
if (flat.a !== 1) throw 'a';
if (flat['b.c'] !== 'hi') throw 'bc';
if (flat['b.d.e'] !== true) throw 'bde';
if (flat.f[0] !== 1) throw 'f';
type F = Flatten<{ a: number; b: { c: string; d: { e: boolean } }; f: number[] }>;
type _t = Expect<Equal<F, { a: number; 'b.c': string; 'b.d.e': boolean; f: number[] }>>;
const _c: _t = true; if (!_c) throw 't';
const vc: string = flat['b.c'];
if (vc.length !== 2) throw 'vc';
const ve: boolean = flat['b.d.e'];
if (ve !== true) throw 've';
const arr: number[] = flat.f;
if (arr.length !== 2) throw 'arr';`, canonical: `type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type Primitive = string | number | boolean | null | undefined | bigint;

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

type Entry<T, Prefix extends string> = [T] extends [Primitive]
  ? { [K in Prefix]: T }
  : [T] extends [readonly any[]]
    ? { [K in Prefix]: T }
    : UnionToIntersection<
        { [K in keyof T & string]: Entry<T[K], Prefix extends '' ? K : \`\${Prefix}.\${K}\`> }[keyof T & string]
      >;

type Flatten<T> = Entry<T, ''> extends infer O ? { [K in keyof O]: O[K] } : never;

function flatten<T extends Record<string, any>>(obj: T): Flatten<T> {
  const out: Record<string, unknown> = {};
  const walk = (cur: any, prefix: string): void => {
    for (const key of Object.keys(cur)) {
      const val = cur[key];
      const nk = prefix ? \`\${prefix}.\${key}\` : key;
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) walk(val, nk);
      else out[nk] = val;
    }
  };
  walk(obj, '');
  return out as Flatten<T>;
}` },
  { id: 'ts-09-exhaustive-match', lang: 'typescript', prompt: `TS:实现可辨识联合的穷尽匹配。给定 Shape = circle/rect/triangle 三个变体(都有 kind 判别字段)。类型 Handlers<U,R> = { [K in U["kind"]]: (shape: Extract<U,{kind:K}>)=>R }(每个 handler 收到被收窄到对应变体的 shape)。函数 matchShape<R>(shape, handlers):R 运行时按 shape.kind 派发。要求:缺少任一变体的 handler 必须是类型错误;在某 handler 内访问其它变体的字段必须是类型错误。再写 area(shape):number 用 matchShape 计算面积。提供 Equal/Expect。只返回代码(顶层声明,无 import/export),用 \`\`\`ts 包裹,不要解释。`, test: `const a1 = area({ kind: 'circle', radius: 2 });
if (Math.abs(a1 - Math.PI * 4) > 1e-9) throw 'a1';
const a2 = area({ kind: 'rect', width: 3, height: 4 });
if (a2 !== 12) throw 'a2';
const a3 = area({ kind: 'triangle', base: 6, height: 4 });
if (a3 !== 12) throw 'a3';
const label = matchShape<string>({ kind: 'rect', width: 1, height: 2 }, {
  circle: (c) => \`circle \${c.radius}\`,
  rect: (r) => \`rect \${r.width}x\${r.height}\`,
  triangle: (t) => \`tri \${t.base}\`,
});
if (label !== 'rect 1x2') throw 'label';
type H = Handlers<Shape, number>;
type CircleHandler = H['circle'];
type _t = Expect<Equal<Parameters<CircleHandler>[0], { kind: 'circle'; radius: number }>>;
const _c: _t = true; if (!_c) throw 't';
type Keys = keyof H;
type _t2 = Expect<Equal<Keys, 'circle' | 'rect' | 'triangle'>>;
const _c2: _t2 = true; if (!_c2) throw 't2';`, canonical: `type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'rect'; width: number; height: number }
  | { kind: 'triangle'; base: number; height: number };

type Handlers<U extends { kind: string }, R> = {
  [K in U['kind']]: (shape: Extract<U, { kind: K }>) => R;
};

function matchShape<R>(shape: Shape, handlers: Handlers<Shape, R>): R {
  const handler = handlers[shape.kind] as (s: Shape) => R;
  return handler(shape);
}

function area(shape: Shape): number {
  return matchShape(shape, {
    circle: (c) => Math.PI * c.radius * c.radius,
    rect: (r) => r.width * r.height,
    triangle: (t) => (t.base * t.height) / 2,
  });
}` },
  { id: 'ts-10-typed-format', lang: 'typescript', prompt: `TS:实现类型安全的格式化 format。用模板字面量类型 ParseFormat<S> 从格式串中解析占位符并推导参数元组:%d/%f -> number,%s -> string,%b -> boolean(非占位符的 % 文本忽略)。函数 format<S extends string>(fmt:S, ...args:ParseFormat<S>):string,参数类型与个数都按格式串约束(错误类型/多传/少传都应是类型错误)。运行时按占位符替换:%f 用 toFixed(2),其余用 String()。例如 format("pi=%f flag=%b", 3.14159, true) === "pi=3.14 flag=true"。提供 Equal/Expect。只返回代码(顶层声明,无 import/export),用 \`\`\`ts 包裹,不要解释。`, test: `const s1 = format('Hello %s, you are %d years old', 'lynn', 30);
if (s1 !== 'Hello lynn, you are 30 years old') throw 's1';
const s2 = format('pi=%f flag=%b', 3.14159, true);
if (s2 !== 'pi=3.14 flag=true') throw 's2';
const s3 = format('no placeholders');
if (s3 !== 'no placeholders') throw 's3';
const s4 = format('%d + %d = %d', 1, 2, 3);
if (s4 !== '1 + 2 = 3') throw 's4';
type Args1 = ParseFormat<'Hello %s, you are %d years old'>;
type _t = Expect<Equal<Args1, [string, number]>>;
const _c: _t = true; if (!_c) throw 't';
type Args2 = ParseFormat<'%f%b%s'>;
type _t2 = Expect<Equal<Args2, [number, boolean, string]>>;
const _c2: _t2 = true; if (!_c2) throw 't2';
type Args3 = ParseFormat<'plain'>;
type _t3 = Expect<Equal<Args3, []>>;
const _c3: _t3 = true; if (!_c3) throw 't3';`, canonical: `type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type SpecType<C extends string> = C extends 'd' | 'f' ? number : C extends 's' ? string : C extends 'b' ? boolean : never;

type ParseFormat<S extends string, Acc extends any[] = []> =
  S extends \`\${infer _Head}%\${infer Spec}\${infer Rest}\`
    ? Spec extends 'd' | 'f' | 's' | 'b'
      ? ParseFormat<Rest, [...Acc, SpecType<Spec>]>
      : ParseFormat<\`\${Spec}\${Rest}\`, Acc>
    : Acc;

function format<S extends string>(fmt: S, ...args: ParseFormat<S>): string {
  let i = 0;
  const out: string[] = [];
  let j = 0;
  while (j < fmt.length) {
    if (fmt[j] === '%' && j + 1 < fmt.length) {
      const spec = fmt[j + 1];
      if (spec === 'd' || spec === 'f' || spec === 's' || spec === 'b') {
        const v = (args as any[])[i++];
        out.push(spec === 'f' ? Number(v).toFixed(2) : String(v));
        j += 2;
        continue;
      }
    }
    out.push(fmt[j]);
    j += 1;
  }
  return out.join('');
}` }
];
