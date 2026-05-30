export default [
  {
    id: 'py-01-recursive-descent-calc',
    lang: 'python',
    prompt: `Python: 实现 \`def evaluate_expr(expr: str)\`,对四则运算表达式求值并返回结果。要求:
- 支持 \`+ - * /\` 与圆括号 \`( )\`,遵循标准优先级(先乘除后加减,括号最高)。
- 支持一元正负号(如 \`-3+5\`、\`2*-3\`、\`--5\`)。
- 支持整数与小数(如 \`3.5*2\`)。
- 表达式合法、无空格;除法用浮点除法。
- 若最终结果是整数值(如 7.0),返回 \`int\`(7);否则返回 \`float\`。
必须自己实现解析(递归下降/调度场均可),不得使用 \`eval\`/\`exec\`/\`ast\` 等。
只返回代码,用 \`\`\`python 包裹,不要解释。`,
    test: `assert evaluate_expr("1+2*3") == 7
assert evaluate_expr("(1+2)*3") == 9
assert evaluate_expr("2*3+4*5") == 26
assert evaluate_expr("10/2/5") == 1
assert evaluate_expr("-3+5") == 2
assert evaluate_expr("2*(3+(4-1))") == 12
assert evaluate_expr("3.5*2") == 7
assert evaluate_expr("--5") == 5
assert evaluate_expr("2*-3") == -6
assert evaluate_expr("((((5))))") == 5
assert evaluate_expr("100") == 100
assert evaluate_expr("7-3-2") == 2`,
    canonical: `import re

def evaluate_expr(expr):
    tokens = re.findall(r'\\d+\\.?\\d*|[+\\-*/()]', expr)
    pos = 0

    def peek():
        return tokens[pos] if pos < len(tokens) else None

    def advance():
        nonlocal pos
        t = tokens[pos]
        pos += 1
        return t

    def parse_expr():
        val = parse_term()
        while peek() in ('+', '-'):
            op = advance()
            rhs = parse_term()
            val = val + rhs if op == '+' else val - rhs
        return val

    def parse_term():
        val = parse_factor()
        while peek() in ('*', '/'):
            op = advance()
            rhs = parse_factor()
            val = val * rhs if op == '*' else val / rhs
        return val

    def parse_factor():
        t = peek()
        if t == '(':
            advance()
            val = parse_expr()
            advance()
            return val
        if t == '-':
            advance()
            return -parse_factor()
        if t == '+':
            advance()
            return parse_factor()
        return float(advance())

    result = parse_expr()
    return int(result) if result == int(result) else result`
  },
  {
    id: 'py-02-task-scheduler-toposort',
    lang: 'python',
    prompt: `Python: 实现 \`def schedule_tasks(deps: dict) -> list\`。
\`deps\` 把每个任务名映射到它依赖的前置任务列表(\`task -> [prereqs]\`)。返回一个合法的执行顺序(每个任务都排在它所有前置之后)。要求:
- 出现在某个依赖列表里但不在 \`deps\` 键中的任务也算作节点(隐式无依赖)。
- 在所有合法拓扑序中,返回字典序最小的那个(每一步在当前所有"已就绪"的任务里选名字最小的)。
- 若存在环(包括自环),抛出 \`ValueError('cycle')\`。
- 空输入返回 \`[]\`。
只返回代码,用 \`\`\`python 包裹,不要解释。`,
    test: `assert schedule_tasks({"a": [], "b": ["a"], "c": ["a", "b"]}) == ["a", "b", "c"]
assert schedule_tasks({"b": ["a"], "a": []}) == ["a", "b"]
assert schedule_tasks({"a": [], "d": [], "b": ["a"], "c": ["d"]}) == ["a", "b", "d", "c"]
assert schedule_tasks({"y": ["x"]}) == ["x", "y"]
assert schedule_tasks({}) == []
try:
    schedule_tasks({"a": ["b"], "b": ["a"]})
    assert False
except ValueError as e:
    assert str(e) == 'cycle'
try:
    schedule_tasks({"a": ["a"]})
    assert False
except ValueError:
    pass`,
    canonical: `import heapq
from collections import defaultdict

def schedule_tasks(deps):
    nodes = set(deps.keys())
    for ps in deps.values():
        nodes.update(ps)
    indeg = {n: 0 for n in nodes}
    adj = defaultdict(list)
    for task, ps in deps.items():
        for p in ps:
            adj[p].append(task)
            indeg[task] += 1
    heap = [n for n in nodes if indeg[n] == 0]
    heapq.heapify(heap)
    order = []
    while heap:
        n = heapq.heappop(heap)
        order.append(n)
        for m in adj[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                heapq.heappush(heap, m)
    if len(order) != len(nodes):
        raise ValueError('cycle')
    return order`
  },
  {
    id: 'py-03-lru-cache-ttl',
    lang: 'python',
    prompt: `Python: 实现带过期时间的 LRU 缓存类 \`LRUCacheTTL\`,签名 \`LRUCacheTTL(capacity, ttl, clock)\`。
- \`clock()\` 返回当前单调时间(数值),用于判定过期,便于测试注入。
- 条目在最近一次写入(\`set\`)后经过 \`ttl\` 个时间单位过期;到达该时刻即视为过期(\`now >= 写入时刻 + ttl\`)。
- \`get(key)\`:键不存在或已过期返回 \`None\` 并删除该过期键;命中存活键时刷新其"最近使用"次序,但**不**刷新 TTL。
- \`set(key, value)\`:写入/覆盖值并重置该键 TTL,标记为最近使用;若容量超出 \`capacity\` 则淘汰最久未使用者(已过期的条目不计入容量,应在淘汰前先清掉)。
- \`__len__\` 返回当前存活(未过期)条目数。
只返回代码,用 \`\`\`python 包裹,不要解释。`,
    test: `t = [0]
c = LRUCacheTTL(2, 10, lambda: t[0])
c.set("a", 1)
c.set("b", 2)
assert c.get("a") == 1
assert c.get("b") == 2
t[0] = 5
assert c.get("a") == 1
c.set("c", 3)
assert c.get("b") is None
assert c.get("a") == 1
assert c.get("c") == 3
t2 = [0]
c2 = LRUCacheTTL(5, 10, lambda: t2[0])
c2.set("x", 100)
t2[0] = 9
assert c2.get("x") == 100
t2[0] = 10
assert c2.get("x") is None
assert len(c2) == 0
t3 = [0]
c3 = LRUCacheTTL(3, 10, lambda: t3[0])
c3.set("p", 1)
t3[0] = 8
assert c3.get("p") == 1
t3[0] = 10
assert c3.get("p") is None
t4 = [0]
c4 = LRUCacheTTL(2, 5, lambda: t4[0])
c4.set("a", 1)
t4[0] = 3
c4.set("b", 2)
t4[0] = 6
c4.set("c", 3)
assert c4.get("a") is None
assert c4.get("b") == 2
assert c4.get("c") == 3
assert len(c4) == 2`,
    canonical: `from collections import OrderedDict

class LRUCacheTTL:
    def __init__(self, capacity, ttl, clock):
        self.capacity = capacity
        self.ttl = ttl
        self.clock = clock
        self.data = OrderedDict()

    def get(self, key):
        if key not in self.data:
            return None
        value, exp = self.data[key]
        if self.clock() >= exp:
            del self.data[key]
            return None
        self.data.move_to_end(key)
        return value

    def set(self, key, value):
        exp = self.clock() + self.ttl
        self.data[key] = (value, exp)
        self.data.move_to_end(key)
        if len(self.data) > self.capacity:
            now = self.clock()
            for k in [k for k, (_, e) in self.data.items() if now >= e]:
                del self.data[k]
            while len(self.data) > self.capacity:
                self.data.popitem(last=False)

    def __len__(self):
        now = self.clock()
        return sum(1 for _, (_, e) in self.data.items() if now < e)`
  },
  {
    id: 'py-04-token-bucket',
    lang: 'python',
    prompt: `Python: 实现令牌桶限流器类 \`TokenBucket\`,签名 \`TokenBucket(rate, capacity, clock)\`。
- 令牌以 \`rate\` 个/秒的速率连续补充,上限为 \`capacity\`;初始为满(\`capacity\` 个)。
- \`clock()\` 返回当前时间(秒,浮点),便于测试注入。
- \`try_consume(n=1)\`:先根据距上次更新经过的时间补充令牌(补充后封顶为 \`capacity\`),若当前令牌 >= n 则扣除 n 并返回 \`True\`,否则不扣除返回 \`False\`。
- 令牌数永远不超过 \`capacity\`、不为负;\`try_consume(0)\` 恒为 \`True\`。
只返回代码,用 \`\`\`python 包裹,不要解释。`,
    test: `t = [0.0]
b = TokenBucket(rate=2, capacity=5, clock=lambda: t[0])
assert b.try_consume(5) is True
assert b.try_consume(1) is False
t[0] = 1.0
assert b.try_consume(2) is True
assert b.try_consume(1) is False
t[0] = 100.0
assert b.try_consume(5) is True
assert b.try_consume(1) is False
t2 = [0.0]
b2 = TokenBucket(rate=1, capacity=10, clock=lambda: t2[0])
assert b2.try_consume(3) is True
t2[0] = 2.0
assert b2.try_consume(9) is True
assert b2.try_consume(1) is False
assert b2.try_consume(0) is True
t3 = [0.0]
b3 = TokenBucket(rate=5, capacity=3, clock=lambda: t3[0])
b3.try_consume(3)
t3[0] = 1000.0
assert b3.try_consume(3) is True
assert b3.try_consume(1) is False`,
    canonical: `class TokenBucket:
    def __init__(self, rate, capacity, clock):
        self.rate = rate
        self.capacity = capacity
        self.clock = clock
        self.tokens = float(capacity)
        self.last = clock()

    def try_consume(self, n=1):
        now = self.clock()
        elapsed = now - self.last
        if elapsed > 0:
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            self.last = now
        if self.tokens >= n:
            self.tokens -= n
            return True
        return False`
  },
  {
    id: 'py-05-max-interval-overlap',
    lang: 'python',
    prompt: `Python: 实现 \`def max_overlap(intervals: list) -> int\`。
\`intervals\` 是若干 \`[start, end)\` 半开区间(end 不含)。返回在任意单点上同时覆盖的最大区间数。要求:
- 空列表返回 0。
- 仅在边界相接的区间(一个的 end == 另一个的 start)**不算**重叠(半开)。
- \`start >= end\` 的空/非法区间视为不贡献任何覆盖,直接忽略。
只返回代码,用 \`\`\`python 包裹,不要解释。`,
    test: `assert max_overlap([]) == 0
assert max_overlap([[1, 2]]) == 1
assert max_overlap([[1, 5], [2, 6], [3, 7]]) == 3
assert max_overlap([[1, 3], [3, 5]]) == 1
assert max_overlap([[1, 10], [2, 3], [4, 5]]) == 2
assert max_overlap([[0, 4], [0, 4], [0, 4], [5, 6]]) == 3
assert max_overlap([[5, 5], [3, 2], [1, 4]]) == 1
assert max_overlap([[1, 4], [2, 5], [5, 8], [6, 9]]) == 2
assert max_overlap([[1, 100], [10, 20], [15, 25], [18, 30]]) == 4`,
    canonical: `def max_overlap(intervals):
    events = []
    for s, e in intervals:
        if s >= e:
            continue
        events.append((s, 1))
        events.append((e, -1))
    events.sort(key=lambda x: (x[0], x[1]))
    cur = 0
    best = 0
    for _, delta in events:
        cur += delta
        if cur > best:
            best = cur
    return best`
  },
  {
    id: 'py-06-lazy-flatten',
    lang: 'python',
    prompt: `Python: 实现生成器函数 \`def lazy_flatten(obj)\`,把任意深度嵌套的可迭代对象按从左到右的顺序惰性展开为扁平的叶子序列(\`yield\` 叶子)。要求:
- \`str\` 与 \`bytes\` 视为**原子叶子**,不要逐字符展开。
- 非可迭代对象(\`int\`、\`None\`、\`float\` 等)是叶子,直接产出。
- 必须真正惰性:只在被消费时才向内层可迭代对象取值,因而能与无限生成器配合(对其取前若干个不会卡死)。
只返回代码,用 \`\`\`python 包裹,不要解释。`,
    test: `import itertools
assert list(lazy_flatten([1, [2, [3, [4]]], 5])) == [1, 2, 3, 4, 5]
assert list(lazy_flatten([1, "ab", [2, "cd"]])) == [1, "ab", 2, "cd"]
assert list(lazy_flatten([])) == []
assert list(lazy_flatten([[], [[]], [[[]]]])) == []
assert list(lazy_flatten(42)) == [42]
assert list(lazy_flatten("hello")) == ["hello"]
assert list(lazy_flatten([None, [True, [1.5]]])) == [None, True, 1.5]
assert list(lazy_flatten([(1, 2), [3, (4, [5])]])) == [1, 2, 3, 4, 5]
assert list(lazy_flatten([(x for x in [10, [20, 30]]), 40])) == [10, 20, 30, 40]
assert list(lazy_flatten(range(3))) == [0, 1, 2]
assert list(itertools.islice(lazy_flatten([[itertools.count(0)], "x"]), 5)) == [0, 1, 2, 3, 4]`,
    canonical: `def lazy_flatten(obj):
    if isinstance(obj, (str, bytes)):
        yield obj
        return
    try:
        it = iter(obj)
    except TypeError:
        yield obj
        return
    for item in it:
        yield from lazy_flatten(item)`
  },
  {
    id: 'py-07-typed-descriptor',
    lang: 'python',
    prompt: `Python: 实现一个数据描述符类 \`Typed\`,用于在类属性上强制类型与可选的 [min, max] 数值边界。用法:
\`\`\`
class Person:
    age = Typed(int, min=0, max=150)
    name = Typed(str)
\`\`\`
- 构造签名 \`Typed(typ, min=None, max=None)\`。
- 赋值时若值不是 \`typ\` 的实例则抛 \`TypeError\`;特别地,期望 \`int\` 时 \`bool\` 值必须被拒绝(\`bool\` 不算合法 \`int\`)。
- 数值越界(\`< min\` 或 \`> max\`)抛 \`ValueError\`;边界值(等于 min 或 max)允许。
- 值按实例存储,不同实例互不影响。
- 任何赋值前读取该属性抛 \`AttributeError\`。
- 通过类(而非实例)访问该属性时返回描述符对象本身。
- 必须用 \`__set_name__\` 自动获知属性名。
只返回代码,用 \`\`\`python 包裹,不要解释。`,
    test: `class Person:
    age = Typed(int, min=0, max=150)
    name = Typed(str)
p = Person()
p.age = 30
p.name = "Lynn"
assert p.age == 30
assert p.name == "Lynn"
try:
    p.age = "old"
    assert False
except TypeError:
    pass
try:
    p.age = True
    assert False
except TypeError:
    pass
try:
    p.age = -1
    assert False
except ValueError:
    pass
try:
    p.age = 200
    assert False
except ValueError:
    pass
p.age = 0
assert p.age == 0
p.age = 150
assert p.age == 150
q = Person()
q.age = 99
assert q.age == 99
assert p.age == 150
r = Person()
try:
    _ = r.age
    assert False
except AttributeError:
    pass
assert isinstance(Person.age, Typed)
try:
    p.name = 123
    assert False
except TypeError:
    pass`,
    canonical: `class Typed:
    def __init__(self, typ, min=None, max=None):
        self.typ = typ
        self.min = min
        self.max = max

    def __set_name__(self, owner, name):
        self.name = name
        self.private = "_typed_" + name

    def __get__(self, instance, owner=None):
        if instance is None:
            return self
        if not hasattr(instance, self.private):
            raise AttributeError(self.name)
        return getattr(instance, self.private)

    def __set__(self, instance, value):
        if self.typ is int and isinstance(value, bool):
            raise TypeError(self.name)
        if not isinstance(value, self.typ):
            raise TypeError(self.name)
        if self.min is not None and value < self.min:
            raise ValueError(self.name)
        if self.max is not None and value > self.max:
            raise ValueError(self.name)
        setattr(instance, self.private, value)`
  },
  {
    id: 'py-08-min-window-substring',
    lang: 'python',
    prompt: `Python: 实现 \`def min_window(s: str, t: str) -> str\`,返回 \`s\` 中包含 \`t\` 所有字符(含重复次数)的最短子串。要求:
- 若不存在这样的子串,返回空串 \`""\`。
- 若有多个长度相同的最短窗口,返回最左边的那个。
- \`s\` 或 \`t\` 为空时返回 \`""\`。
- 需达到线性时间复杂度(滑动窗口),不要暴力枚举所有子串。
只返回代码,用 \`\`\`python 包裹,不要解释。`,
    test: `assert min_window("ADOBECODEBANC", "ABC") == "BANC"
assert min_window("a", "a") == "a"
assert min_window("a", "aa") == ""
assert min_window("", "a") == ""
assert min_window("a", "") == ""
assert min_window("aaab", "aa") == "aa"
assert min_window("bba", "ab") == "ba"
assert min_window("abab", "ab") == "ab"
assert min_window("cabwefgewcwaefgcf", "cae") == "cwae"
assert min_window("xyz", "a") == ""
assert min_window("ab", "abc") == ""
assert min_window("aaaaaaaaaaaabbbbbcdd", "abcdd") == "abbbbbcdd"`,
    canonical: `from collections import Counter

def min_window(s, t):
    if not t or not s:
        return ""
    need = Counter(t)
    missing = len(t)
    left = 0
    best = (float('inf'), 0, 0)
    for right, ch in enumerate(s):
        if need[ch] > 0:
            missing -= 1
        need[ch] -= 1
        while missing == 0:
            if right - left + 1 < best[0]:
                best = (right - left + 1, left, right + 1)
            need[s[left]] += 1
            if need[s[left]] > 0:
                missing += 1
            left += 1
    return "" if best[0] == float('inf') else s[best[1]:best[2]]`
  },
  {
    id: 'py-09-async-gather-limited',
    lang: 'python',
    prompt: `Python: 实现 \`async def gather_limited(coro_factories, limit)\`。
\`coro_factories\` 是一组**无参可调用对象**,每次调用返回一个全新的 awaitable。要求:
- 并发运行这些 awaitable,但任意时刻最多只有 \`limit\` 个在执行中(\`limit >= 1\`)。
- 返回结果列表,顺序与输入列表**一致**(不是完成顺序)。
- 输入为空时返回 \`[]\`。
提示:可用 \`asyncio.Semaphore\` 限制并发,用 \`asyncio.gather\` 收集。
只返回代码,用 \`\`\`python 包裹,不要解释。`,
    test: `import asyncio, time
assert asyncio.run(gather_limited(
    [(lambda v=i: asyncio.sleep(0, result=v * v)) for i in range(6)], 2)) == [0, 1, 4, 9, 16, 25]
assert asyncio.run(gather_limited([
    (lambda: asyncio.sleep(0.03, result="a")),
    (lambda: asyncio.sleep(0.02, result="b")),
    (lambda: asyncio.sleep(0.01, result="c")),
], 3)) == ["a", "b", "c"]
assert asyncio.run(gather_limited([], 4)) == []
assert asyncio.run(gather_limited([(lambda: asyncio.sleep(0, result=99))], 1)) == [99]
assert (lambda _s: (asyncio.run(gather_limited(
    [(lambda: asyncio.sleep(0.05, result=1)) for _ in range(6)], 2)) == [1] * 6)
    and (time.monotonic() - _s) >= 0.13)(time.monotonic())`,
    canonical: `import asyncio

async def gather_limited(coro_factories, limit):
    if not coro_factories:
        return []
    sem = asyncio.Semaphore(limit)
    results = [None] * len(coro_factories)

    async def run(i, factory):
        async with sem:
            results[i] = await factory()

    await asyncio.gather(*(run(i, f) for i, f in enumerate(coro_factories)))
    return results`
  },
  {
    id: 'py-10-largest-rectangle-histogram',
    lang: 'python',
    prompt: `Python: 实现 \`def largest_rectangle(heights: list) -> int\`。给定若干宽度均为 1 的非负柱高,返回完全位于直方图轮廓之下的最大轴对齐矩形面积。要求:
- 空列表返回 0。
- 需达到 O(n) 时间复杂度(单调栈),不要 O(n^2) 暴力。
只返回代码,用 \`\`\`python 包裹,不要解释。`,
    test: `assert largest_rectangle([2, 1, 5, 6, 2, 3]) == 10
assert largest_rectangle([]) == 0
assert largest_rectangle([0]) == 0
assert largest_rectangle([5]) == 5
assert largest_rectangle([1, 1, 1, 1]) == 4
assert largest_rectangle([2, 4]) == 4
assert largest_rectangle([6, 2, 5, 4, 5, 1, 6]) == 12
assert largest_rectangle([4, 2, 0, 3, 2, 5]) == 6
assert largest_rectangle([1, 2, 3, 4, 5]) == 9
assert largest_rectangle([5, 4, 3, 2, 1]) == 9
assert largest_rectangle([3, 0, 3]) == 3
assert largest_rectangle([2, 2, 2, 2, 2, 2]) == 12
assert largest_rectangle([1, 1, 100, 1, 1]) == 100`,
    canonical: `def largest_rectangle(heights):
    stack = []
    best = 0
    n = len(heights)
    for i in range(n + 1):
        h = heights[i] if i < n else 0
        while stack and heights[stack[-1]] >= h:
            top = stack.pop()
            height = heights[top]
            left = stack[-1] if stack else -1
            width = i - left - 1
            area = height * width
            if area > best:
                best = area
        stack.append(i)
    return best`
  }
];
